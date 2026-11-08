package memory

import (
	"sync"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// member is one client connection in a room and implements domain.RoomSession.
// Fields marked "room" are touched only by the room goroutine.
type member struct {
	hub  *Hub
	room *room
	id   uint64
	peer domain.Peer

	out    chan domain.Event
	closed chan struct{}

	closeOnce sync.Once
	reason    domain.CloseReason // written before closed is closed

	snapshot domain.RoomSnapshot // room, read by the owner after Join returns
	removed  bool                // room

	limiter *rateLimiter
}

var _ domain.RoomSession = (*member)(nil)

func newMember(h *Hub, r *room, peer domain.Peer) *member {
	return &member{
		hub:     h,
		room:    r,
		id:      h.nextID.Add(1),
		peer:    peer,
		out:     make(chan domain.Event, h.cfg.SendBuffer),
		closed:  make(chan struct{}),
		limiter: newRateLimiter(h.cfg.RatePerSecond, h.cfg.Clock),
	}
}

// closeWith marks the session closed and reports whether this call did it.
func (m *member) closeWith(reason domain.CloseReason) bool {
	first := false
	m.closeOnce.Do(func() {
		first = true
		m.reason = reason
		close(m.closed)
	})
	return first
}

func (m *member) isClosed() bool {
	select {
	case <-m.closed:
		return true
	default:
		return false
	}
}

// Snapshot implements domain.RoomSession.
func (m *member) Snapshot() domain.RoomSnapshot { return m.snapshot }

// Events implements domain.RoomSession.
func (m *member) Events() <-chan domain.Event { return m.out }

// Closed implements domain.RoomSession.
func (m *member) Closed() <-chan struct{} { return m.closed }

// CloseReason implements domain.RoomSession.
func (m *member) CloseReason() domain.CloseReason {
	select {
	case <-m.closed:
		return m.reason
	default:
		return domain.CloseNone
	}
}

// Allow implements domain.RoomSession.
func (m *member) Allow() bool {
	if m.limiter.allow() {
		return true
	}
	m.hub.cfg.Metrics.RateLimited()
	return false
}

// SetCursor implements domain.RoomSession.
func (m *member) SetCursor(c domain.Cursor) {
	m.hub.cfg.Metrics.MessageIn("cursor")
	m.room.do(func(r *room) { r.setCursor(m, c) })
}

type acquireResult struct {
	info domain.LockInfo
	err  error
}

// Acquire implements domain.RoomSession.
func (m *member) Acquire(rowID string) (domain.LockInfo, error) {
	m.hub.cfg.Metrics.MessageIn("lock.acquire")
	reply := make(chan acquireResult, 1)
	m.room.do(func(r *room) {
		info, err := r.acquire(m, rowID)
		reply <- acquireResult{info, err}
	})
	select {
	case res := <-reply:
		return res.info, res.err
	case <-m.room.done:
		return domain.LockInfo{}, ErrHubClosed
	}
}

// Release implements domain.RoomSession.
func (m *member) Release(rowID string) {
	m.hub.cfg.Metrics.MessageIn("lock.release")
	m.room.do(func(r *room) { r.release(m, rowID) })
}

// Heartbeat implements domain.RoomSession.
func (m *member) Heartbeat() {
	m.hub.cfg.Metrics.MessageIn("ping")
	m.room.do(func(r *room) { r.heartbeat(m) })
}

// Leave implements domain.RoomSession.
func (m *member) Leave() {
	m.room.do(func(r *room) { r.remove(m) })
}

// rateLimiter is a token bucket refilled from the injected clock: the burst
// equals the per-second rate, so a client may send `rate` messages at once and
// `rate` per second on average.
type rateLimiter struct {
	mu     sync.Mutex
	rate   float64
	tokens float64
	last   time.Time
	clock  Clock
}

func newRateLimiter(perSecond int, c Clock) *rateLimiter {
	return &rateLimiter{rate: float64(perSecond), tokens: float64(perSecond), last: c.Now(), clock: c}
}

func (l *rateLimiter) allow() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock.Now()
	if d := now.Sub(l.last); d > 0 {
		l.tokens = min(l.rate, l.tokens+d.Seconds()*l.rate)
		l.last = now
	}
	if l.tokens < 1 {
		return false
	}
	l.tokens--
	return true
}
