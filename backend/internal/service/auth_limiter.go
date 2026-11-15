package service

import (
	"net/netip"
	"sync"
	"time"
)

// Login throttling limits (docs/02-architecture.md, section 7).
const (
	loginPairLimit = 5   // attempts per address and login
	loginIPLimit   = 20  // attempts per address
	loginNameLimit = 100 // failed attempts per login over all addresses
	loginWindow    = 15 * time.Minute
	// loginMaxInFlight bounds the logins and password changes running at once. argon2 admits only a
	// couple of hashes at a time, so more than a few waiting requests just queue real users behind
	// an unauthenticated flood; the surplus is rejected at once instead. loginReservedSlots of them
	// are kept for addresses that already logged in to that account successfully, and
	// loginAddrInFlight stops a single address (an IPv6 /64) from taking the shared ones.
	loginMaxInFlight   = 8
	loginReservedSlots = 2
	loginAddrInFlight  = 2
	loginBusyRetry     = time.Second
	// loginTrustTTL and loginTrustMax bound the memory of successful (login, address) pairs. Such a
	// pair is not stopped by the per-login ceiling, so an attacker who locks a victim out from
	// elsewhere cannot lock the victim's own address out. The memory is lost on restart.
	loginTrustTTL = 12 * time.Hour
	loginTrustMax = 10000
	// limiterMaxKeys bounds the memory of every counter set.
	limiterMaxKeys = 20000
	// loginFullRetry is the answer for an unseen identity when a counter set is full of live
	// windows: it is refused rather than allowed to evict a throttle that may belong to an attacker.
	loginFullRetry = 30 * time.Second
)

// Refresh throttling limits. A browser refreshes about once per access token lifetime (15
// minutes) plus once per page load, so these are far above honest use and only stop a loop.
const (
	refreshFamilyLimit = 30
	refreshIPLimit     = 120
	refreshWindow      = time.Minute
)

// failureAuditWindow is the minimum gap between audit rows for failed logins of one address and
// login: a sustained attack must not push real administrative actions out of the capped audit log.
const failureAuditWindow = time.Minute

// limiterIP maps an address to its throttling identity: IPv6 clients usually own a whole /64, so
// counting single addresses would give an attacker unlimited identities. IPv4 stays as is.
func limiterIP(ip string) string {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	a = a.Unmap()
	if a.Is6() {
		return netip.PrefixFrom(a, 64).Masked().String()
	}
	return a.String()
}

// evictScan bounds how many queue entries one eviction looks at.
const evictScan = 256

// windowSet is a size-limited map of fixed-window counters whose windows all last span. Windows
// are also kept in a FIFO queue ordered by start time, so expired ones are dropped from the head
// in amortised O(1) instead of scanning the whole map under the caller's lock. When the set is
// full of live windows, only those the evictable policy allows are dropped (nil allows all); if
// none qualifies, add refuses, and the caller decides whether that fails closed. Not safe for
// concurrent use.
type windowSet struct {
	span      time.Duration
	max       int
	evictable func(w *window) bool
	m         map[string]*window
	queue     []windowStart
	head      int
}

type window struct {
	n     int
	start time.Time
}

type windowStart struct {
	key   string
	start time.Time
}

func newWindowSet(span time.Duration, maxKeys int, evictable func(*window) bool) *windowSet {
	return &windowSet{span: span, max: maxKeys, evictable: evictable, m: make(map[string]*window)}
}

// farFromLimit builds an eviction policy that only gives up windows at or below half of limit,
// so a throttle that is close to biting is never forgotten to make room.
func farFromLimit(limit int) func(*window) bool {
	return func(w *window) bool { return w.n*2 <= limit }
}

// never is the eviction policy of sets whose live windows must all survive.
func never(*window) bool { return false }

// live returns the open window of key, or nil when there is none or it has ended.
func (s *windowSet) live(key string, now time.Time) *window {
	w := s.m[key]
	if w != nil && now.Sub(w.start) >= s.span {
		delete(s.m, key)
		return nil
	}
	return w
}

// room reports whether key can be counted: it is already tracked or a window can be created.
func (s *windowSet) room(key string, now time.Time) bool {
	if s.live(key, now) != nil {
		return true
	}
	s.evict(now)
	return len(s.m) < s.max
}

// add counts one event for key, opening a new window when needed, and returns the window, or nil
// when the set is full and nothing may be evicted.
func (s *windowSet) add(key string, now time.Time) *window {
	w := s.live(key, now)
	if w == nil {
		s.evict(now)
		if len(s.m) >= s.max {
			return nil
		}
		w = &window{start: now}
		s.m[key] = w
		s.queue = append(s.queue, windowStart{key, now})
	}
	w.n++
	return w
}

// refund takes one event back (an attempt that turned out not to count); it never goes below zero.
func (s *windowSet) refund(key string) {
	if w := s.m[key]; w != nil && w.n > 0 {
		w.n--
	}
}

// reset forgets the events of key but keeps its window, so the queue does not grow.
func (s *windowSet) reset(key string) {
	if w := s.m[key]; w != nil {
		w.n = 0
	}
}

// retryAfter is how long the window of key stays closed to new events once it holds limit of them.
func (s *windowSet) retryAfter(key string, limit int, now time.Time) time.Duration {
	if w := s.live(key, now); w != nil && w.n >= limit {
		return s.span - now.Sub(w.start)
	}
	return 0
}

// evict drops ended windows from the head of the queue and, if the set is still full, one live
// window the policy allows.
func (s *windowSet) evict(now time.Time) {
	for s.head < len(s.queue) {
		e := s.queue[s.head]
		w := s.m[e.key]
		if w != nil && w.start.Equal(e.start) {
			if now.Sub(w.start) < s.span {
				break
			}
			delete(s.m, e.key)
		}
		s.head++ // ended, or stale because the key was dropped or restarted since
	}
	if len(s.m) >= s.max {
		for i := s.head; i < len(s.queue) && i < s.head+evictScan; i++ {
			e := s.queue[i]
			w := s.m[e.key]
			if w == nil || !w.start.Equal(e.start) || (s.evictable != nil && !s.evictable(w)) {
				continue
			}
			delete(s.m, e.key)
			break
		}
	}
	if s.head >= 1024 && s.head*2 >= len(s.queue) {
		s.queue = append(s.queue[:0], s.queue[s.head:]...)
		s.head = 0
	}
}

// MemoryLoginLimiter counts login attempts in process memory: 5 per address+login and 20 per
// address within 15 minutes, 100 failures per login over all addresses, and a bounded number of
// attempts in flight. An attempt is counted when it is reserved, before the password is checked,
// so parallel requests cannot all slip under the budget while the counters still read zero; it
// is given back unless it failed on credentials. Only failures count towards the per-login
// ceiling, and an address that already logged in to that account is exempt from it, so locking a
// login from elsewhere does not lock out its owner. Each key type has its own size-limited set,
// and each gives up only windows far below its limit, so a flood of made-up logins cannot fill the per-login set and
// refuse real ones while a counter close to biting is never forgotten. State is lost on restart, which is acceptable
// for brute-force throttling on a single instance.
type MemoryLoginLimiter struct {
	clock Clock

	mu       sync.Mutex
	pairs    *windowSet // address+login, attempts
	addrs    *windowSet // address, attempts
	names    *windowSet // login, failures
	trusted  *windowSet // address+login pairs that logged in successfully
	inFlight int
	perAddr  map[string]int
}

// NewMemoryLoginLimiter creates a limiter reading time from clock.
func NewMemoryLoginLimiter(clock Clock) *MemoryLoginLimiter {
	return &MemoryLoginLimiter{
		clock:   clock,
		pairs:   newWindowSet(loginWindow, limiterMaxKeys, farFromLimit(loginPairLimit)),
		addrs:   newWindowSet(loginWindow, limiterMaxKeys, farFromLimit(loginIPLimit)),
		names:   newWindowSet(loginWindow, limiterMaxKeys, farFromLimit(loginNameLimit)),
		trusted: newWindowSet(loginTrustTTL, loginTrustMax, nil),
		perAddr: make(map[string]int),
	}
}

func pairKey(ip, login string) string { return "p|" + ip + "|" + login }

// Reserve implements LoginLimiter.
func (l *MemoryLoginLimiter) Reserve(ip, login string) (func(failed bool), time.Duration) {
	now := l.clock.Now()
	addr := limiterIP(ip)
	pair := pairKey(addr, login)

	l.mu.Lock()
	defer l.mu.Unlock()
	trusted := l.trusted.live(pair, now) != nil
	slots := loginMaxInFlight - loginReservedSlots
	if trusted {
		slots = loginMaxInFlight
	}
	if l.inFlight >= slots || l.perAddr[addr] >= loginAddrInFlight {
		return nil, loginBusyRetry
	}
	wait := max(l.pairs.retryAfter(pair, loginPairLimit, now), l.addrs.retryAfter(addr, loginIPLimit, now))
	if !trusted {
		wait = max(wait, l.names.retryAfter(login, loginNameLimit, now))
	}
	if wait > 0 {
		return nil, wait
	}
	// A set full of live windows refuses an identity it has not seen instead of forgetting
	// someone else's counter; an address that proved itself by logging in is let through uncounted.
	if !trusted && !l.names.room(login, now) {
		return nil, loginFullRetry
	}
	pw, aw := l.pairs.add(pair, now), l.addrs.add(addr, now)
	if !trusted && (pw == nil || aw == nil) {
		if pw != nil {
			l.pairs.refund(pair)
		}
		if aw != nil {
			l.addrs.refund(addr)
		}
		return nil, loginFullRetry
	}
	l.inFlight++
	l.perAddr[addr]++

	var once sync.Once
	return func(failed bool) {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.inFlight--
			if l.perAddr[addr]--; l.perAddr[addr] <= 0 {
				delete(l.perAddr, addr)
			}
			if failed {
				l.names.add(login, l.clock.Now())
				return
			}
			if pw != nil {
				l.pairs.refund(pair)
			}
			if aw != nil {
				l.addrs.refund(addr)
			}
		})
	}, 0
}

// Succeed implements LoginLimiter: it clears the pair counter but keeps the per-address one, so
// an attacker with one valid account cannot reset the address budget, and remembers the pair as
// trusted.
func (l *MemoryLoginLimiter) Succeed(ip, login string) {
	now := l.clock.Now()
	pair := pairKey(limiterIP(ip), login)
	l.mu.Lock()
	defer l.mu.Unlock()
	l.pairs.reset(pair)
	if l.trusted.live(pair, now) == nil {
		l.trusted.add(pair, now)
	}
}

// MemoryRefreshLimiter throttles POST /auth/refresh per login chain and per address. Refreshing
// needs a validly signed token, so the sets cannot be flooded anonymously and simply drop their
// oldest windows when full.
type MemoryRefreshLimiter struct {
	clock Clock

	mu     sync.Mutex
	family *windowSet
	addr   *windowSet
}

// NewMemoryRefreshLimiter creates a limiter reading time from clock.
func NewMemoryRefreshLimiter(clock Clock) *MemoryRefreshLimiter {
	return &MemoryRefreshLimiter{
		clock:  clock,
		family: newWindowSet(refreshWindow, limiterMaxKeys, nil),
		addr:   newWindowSet(refreshWindow, limiterMaxKeys, nil),
	}
}

// Allow counts a refresh attempt and returns a positive duration when it must be rejected with
// RATE_LIMITED. Rejected attempts are not counted, so the window still ends on schedule.
func (l *MemoryRefreshLimiter) Allow(ip, family string) time.Duration {
	now := l.clock.Now()
	ip = limiterIP(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	if wait := max(l.family.retryAfter(family, refreshFamilyLimit, now), l.addr.retryAfter(ip, refreshIPLimit, now)); wait > 0 {
		return wait
	}
	l.family.add(family, now)
	l.addr.add(ip, now)
	return 0
}

// failureAudit thins out the audit rows of failed logins to one per address and login per
// failureAuditWindow.
type failureAudit struct {
	clock Clock

	mu  sync.Mutex
	set *windowSet
}

func newFailureAudit(clock Clock) *failureAudit {
	return &failureAudit{clock: clock, set: newWindowSet(failureAuditWindow, limiterMaxKeys, nil)}
}

// sample reports whether this failure gets an audit row and, if so, the number of failures it
// stands for: itself plus those skipped since the previous row. The skipped count is best effort:
// it is lost when the earlier window has already been dropped from memory.
func (f *failureAudit) sample(ip, login string) (emit bool, count int) {
	now := f.clock.Now()
	key := pairKey(limiterIP(ip), login)
	f.mu.Lock()
	defer f.mu.Unlock()
	prev := f.set.m[key]
	w := f.set.add(key, now)
	if w == nil {
		return false, 0
	}
	if w.n > 1 {
		return false, 0
	}
	count = 1
	if prev != nil && prev != w {
		count += prev.n - 1
	}
	return true, count
}
