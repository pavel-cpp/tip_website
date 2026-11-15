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
	loginNameLimit = 100 // attempts per login over all addresses, so a botnet cannot brute-force one account
	loginWindow    = 15 * time.Minute
	// loginMaxInFlight bounds the logins and password changes running at once. argon2 admits only a
	// couple of hashes at a time, so more than a few waiting requests just queue real users behind
	// an unauthenticated flood; the surplus is rejected at once instead.
	loginMaxInFlight = 8
	loginBusyRetry   = time.Second
	// limiterMaxKeys bounds the memory of one counter set. When it is full the oldest windows are
	// dropped first, which can only forget a throttle, never block a new client.
	limiterMaxKeys = 50000
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

// windowSet is a map of fixed-window counters whose windows all last span. Windows are also kept
// in a FIFO queue ordered by start time, so expired ones are dropped from the head in amortised
// O(1) instead of scanning the whole map under the caller's lock. Not safe for concurrent use.
type windowSet struct {
	span  time.Duration
	m     map[string]*window
	queue []windowStart
	head  int
}

type window struct {
	n     int
	start time.Time
}

type windowStart struct {
	key   string
	start time.Time
}

func newWindowSet(span time.Duration) *windowSet {
	return &windowSet{span: span, m: make(map[string]*window)}
}

// live returns the open window of key, or nil when there is none or it has ended.
func (s *windowSet) live(key string, now time.Time) *window {
	w := s.m[key]
	if w != nil && now.Sub(w.start) >= s.span {
		delete(s.m, key)
		return nil
	}
	return w
}

// add counts one event for key, opening a new window when needed, and returns the window.
func (s *windowSet) add(key string, now time.Time) *window {
	w := s.live(key, now)
	if w == nil {
		s.evict(now)
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

// evict drops ended windows from the head of the queue and, if the map is still full, the oldest
// live ones.
func (s *windowSet) evict(now time.Time) {
	for s.head < len(s.queue) {
		e := s.queue[s.head]
		if now.Sub(e.start) < s.span && len(s.m) < limiterMaxKeys {
			break
		}
		// A queue entry is stale when its key was dropped or restarted since.
		if w := s.m[e.key]; w != nil && w.start.Equal(e.start) {
			delete(s.m, e.key)
		}
		s.head++
	}
	if s.head >= 1024 && s.head*2 >= len(s.queue) {
		s.queue = append(s.queue[:0], s.queue[s.head:]...)
		s.head = 0
	}
}

// MemoryLoginLimiter counts login attempts in process memory: 5 per address+login, 20 per address
// and 100 per login within 15 minutes, with at most loginMaxInFlight running at once. An attempt
// is counted when it is reserved, before the password is checked, so parallel requests cannot all
// slip under the budget while the counters still read zero; it is given back unless it failed
// on credentials. State is lost on restart, which is acceptable for brute-force throttling on a
// single instance.
type MemoryLoginLimiter struct {
	clock Clock

	mu       sync.Mutex
	set      *windowSet
	inFlight int
}

// NewMemoryLoginLimiter creates a limiter reading time from clock.
func NewMemoryLoginLimiter(clock Clock) *MemoryLoginLimiter {
	return &MemoryLoginLimiter{clock: clock, set: newWindowSet(loginWindow)}
}

func pairKey(ip, login string) string { return "p|" + ip + "|" + login }
func ipKey(ip string) string          { return "i|" + ip }
func nameKey(login string) string     { return "n|" + login }

// Reserve implements LoginLimiter.
func (l *MemoryLoginLimiter) Reserve(ip, login string) (func(failed bool), time.Duration) {
	now := l.clock.Now()
	ip = limiterIP(ip)
	pair, byIP, byName := pairKey(ip, login), ipKey(ip), nameKey(login)

	l.mu.Lock()
	defer l.mu.Unlock()
	if l.inFlight >= loginMaxInFlight {
		return nil, loginBusyRetry
	}
	wait := max(
		l.set.retryAfter(pair, loginPairLimit, now),
		l.set.retryAfter(byIP, loginIPLimit, now),
		l.set.retryAfter(byName, loginNameLimit, now),
	)
	if wait > 0 {
		return nil, wait
	}
	l.inFlight++
	l.set.add(pair, now)
	l.set.add(byIP, now)
	l.set.add(byName, now)

	var once sync.Once
	return func(failed bool) {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.inFlight--
			if !failed {
				l.set.refund(pair)
				l.set.refund(byIP)
				l.set.refund(byName)
			}
		})
	}, 0
}

// Succeed implements LoginLimiter: it clears the pair counter but keeps the per-address one, so
// an attacker with one valid account cannot reset the address budget.
func (l *MemoryLoginLimiter) Succeed(ip, login string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.set.reset(pairKey(limiterIP(ip), login))
}

// MemoryRefreshLimiter throttles POST /auth/refresh per login chain and per address.
type MemoryRefreshLimiter struct {
	clock Clock

	mu     sync.Mutex
	family *windowSet
	addr   *windowSet
}

// NewMemoryRefreshLimiter creates a limiter reading time from clock.
func NewMemoryRefreshLimiter(clock Clock) *MemoryRefreshLimiter {
	return &MemoryRefreshLimiter{clock: clock, family: newWindowSet(refreshWindow), addr: newWindowSet(refreshWindow)}
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
	return &failureAudit{clock: clock, set: newWindowSet(failureAuditWindow)}
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
	if w.n > 1 {
		return false, 0
	}
	count = 1
	if prev != nil && prev != w {
		count += prev.n - 1
	}
	return true, count
}
