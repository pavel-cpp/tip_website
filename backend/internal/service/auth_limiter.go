package service

import (
	"sync"
	"time"
)

// Login throttling limits (docs/02-architecture.md, section 7).
const (
	loginPairLimit = 5
	loginIPLimit   = 20
	loginWindow    = 15 * time.Minute
)

// MemoryLoginLimiter is a fixed-window failure counter kept in process memory: 5 failures per
// IP+login pair and 20 per IP within 15 minutes. State is lost on restart, which is acceptable
// for brute-force throttling on a single instance.
type MemoryLoginLimiter struct {
	clock Clock

	mu     sync.Mutex
	counts map[string]*window
}

type window struct {
	n     int
	start time.Time
}

// NewMemoryLoginLimiter creates a limiter reading time from clock.
func NewMemoryLoginLimiter(clock Clock) *MemoryLoginLimiter {
	return &MemoryLoginLimiter{clock: clock, counts: make(map[string]*window)}
}

func pairKey(ip, login string) string { return "p|" + ip + "|" + login }
func ipKey(ip string) string          { return "i|" + ip }

// live returns the active window for key, dropping an expired one.
func (l *MemoryLoginLimiter) live(key string, now time.Time) *window {
	w := l.counts[key]
	if w != nil && now.Sub(w.start) >= loginWindow {
		delete(l.counts, key)
		return nil
	}
	return w
}

// Check implements LoginLimiter.
func (l *MemoryLoginLimiter) Check(ip, login string) time.Duration {
	now := l.clock.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	var wait time.Duration
	if w := l.live(pairKey(ip, login), now); w != nil && w.n >= loginPairLimit {
		wait = loginWindow - now.Sub(w.start)
	}
	if w := l.live(ipKey(ip), now); w != nil && w.n >= loginIPLimit {
		wait = max(wait, loginWindow-now.Sub(w.start))
	}
	return wait
}

// Fail implements LoginLimiter.
func (l *MemoryLoginLimiter) Fail(ip, login string) {
	now := l.clock.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweep(now)
	for _, key := range []string{pairKey(ip, login), ipKey(ip)} {
		w := l.live(key, now)
		if w == nil {
			w = &window{start: now}
			l.counts[key] = w
		}
		w.n++
	}
}

// Succeed implements LoginLimiter: it clears the pair counter but keeps the per-IP one, so
// an attacker with one valid account cannot reset the IP budget.
func (l *MemoryLoginLimiter) Succeed(ip, login string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.counts, pairKey(ip, login))
}

// sweep bounds memory by discarding expired windows once the map grows large.
func (l *MemoryLoginLimiter) sweep(now time.Time) {
	if len(l.counts) < 4096 {
		return
	}
	for k, w := range l.counts {
		if now.Sub(w.start) >= loginWindow {
			delete(l.counts, k)
		}
	}
}
