// Package memory holds in-process state. The Hub keeps realtime presence,
// cursors and row locks of project rooms; nothing in it is persisted.
package memory

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// Defaults from docs/02-architecture.md, section 6.
const (
	DefaultSendBuffer    = 64
	DefaultRatePerSecond = 20
	DefaultSweepInterval = time.Second
	// roomInbox bounds queued room commands; the room never blocks, so it drains fast.
	roomInbox = 256
	// maxLocksPerSession stops a misbehaving client from locking the whole table.
	maxLocksPerSession = 16
)

// ErrHubClosed is returned by Join after Shutdown.
var ErrHubClosed = errors.New("realtime hub is shut down")

// Clock supplies the current time (satisfied by platform/clock.System).
type Clock interface{ Now() time.Time }

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now().UTC() }

// Config tunes a Hub; zero values select the documented defaults.
type Config struct {
	Clock         Clock
	Metrics       Metrics
	SendBuffer    int
	RatePerSecond int
	SweepInterval time.Duration
}

// Hub routes realtime traffic between the clients of project rooms. Every room
// is owned by a single goroutine that holds its clients, cursors and locks, so
// room state needs no locking. The only shared structures are the room
// registry and a read-mostly index of live locks (for EnsureFree); both are
// guarded by short critical sections that never run room logic.
type Hub struct {
	cfg Config

	mu     sync.RWMutex
	rooms  map[string]*room
	closed bool
	wg     sync.WaitGroup

	lockMu sync.RWMutex
	locks  map[string]domain.RowLock

	nextID atomic.Uint64
}

// NewHub creates an empty Hub.
func NewHub(cfg Config) *Hub {
	if cfg.SendBuffer <= 0 {
		cfg.SendBuffer = DefaultSendBuffer
	}
	if cfg.RatePerSecond <= 0 {
		cfg.RatePerSecond = DefaultRatePerSecond
	}
	if cfg.SweepInterval <= 0 {
		cfg.SweepInterval = DefaultSweepInterval
	}
	if cfg.Metrics == nil {
		cfg.Metrics = NopMetrics{}
	}
	if cfg.Clock == nil {
		cfg.Clock = systemClock{}
	}
	return &Hub{cfg: cfg, rooms: make(map[string]*room), locks: make(map[string]domain.RowLock)}
}

// Join adds a client to the room of projectID, creating the room on demand.
func (h *Hub) Join(ctx context.Context, projectID string, peer domain.Peer) (domain.RoomSession, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	r, err := h.acquireRoom(projectID)
	if err != nil {
		return nil, err
	}
	m := newMember(h, r, peer)
	reply := make(chan struct{})
	// The reference taken in acquireRoom keeps the room goroutine alive, so this send cannot be lost.
	r.inbox <- func(r *room) {
		r.join(m)
		close(reply)
	}
	<-reply
	return m, nil
}

// acquireRoom returns the room of the project with its reference count raised.
// The count covers members and in-flight joins; the room exits when it drops to zero.
func (h *Hub) acquireRoom(projectID string) (*room, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, ErrHubClosed
	}
	r, ok := h.rooms[projectID]
	if !ok {
		r = newRoom(h, projectID)
		h.rooms[projectID] = r
		h.wg.Add(1)
		h.cfg.Metrics.RoomOpened()
		go r.run()
	}
	r.refs++
	return r, nil
}

// releaseRoom drops one reference and reports whether the room must exit.
func (h *Hub) releaseRoom(r *room) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	r.refs--
	if r.refs > 0 {
		return false
	}
	delete(h.rooms, r.id)
	h.cfg.Metrics.RoomClosed()
	return true
}

func (h *Hub) room(projectID string) *room {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.rooms[projectID]
}

func (h *Hub) allRooms() []*room {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]*room, 0, len(h.rooms))
	for _, r := range h.rooms {
		out = append(out, r)
	}
	return out
}

// Publish fans a domain event out to the clients of a project room. It never
// blocks on slow clients, so callers may invoke it right after a transaction.
func (h *Hub) Publish(projectID string, e domain.Event) {
	r := h.room(projectID)
	if r == nil {
		return
	}
	if re, ok := e.(domain.ReauthEvent); ok {
		r.do(func(r *room) { r.reauth(re.UserID) })
		return
	}
	r.do(func(r *room) { r.broadcast(e, nil) })
}

// Online returns the users connected to each of the projects, one entry per user and sorted by
// id. Projects with nobody connected are absent from the result.
func (h *Hub) Online(ctx context.Context, projectIDs []string) map[string][]domain.Peer {
	out := make(map[string][]domain.Peer)
	for _, id := range projectIDs {
		r := h.room(id)
		if r == nil {
			continue
		}
		reply := make(chan []domain.Peer, 1)
		r.do(func(r *room) { reply <- r.peers() })
		select {
		case peers := <-reply:
			if len(peers) > 0 {
				out[id] = peers
			}
		case <-r.done:
		case <-ctx.Done():
			return out
		}
	}
	return out
}

// BroadcastReauth asks the connections of userID (all users when empty) to
// present a fresh token, for example after the permission epoch grew.
func (h *Hub) BroadcastReauth(userID string) {
	for _, r := range h.allRooms() {
		r.do(func(r *room) { r.reauth(userID) })
	}
}

// KickUser closes every connection of the user with CloseKicked, used after
// deactivation or a password reset.
func (h *Hub) KickUser(userID string) {
	for _, r := range h.allRooms() {
		r.do(func(r *room) { r.kick(userID) })
	}
}

// EnsureFree reports ROW_LOCKED (carrying the owner) when another user holds a
// live lock on the row. It reads the lock index and does not touch rooms.
func (h *Hub) EnsureFree(_ context.Context, rowID, userID string) error {
	h.lockMu.RLock()
	l, ok := h.locks[rowID]
	h.lockMu.RUnlock()
	if !ok {
		return nil
	}
	return l.EnsureAvailableTo(userID, h.cfg.Clock.Now())
}

// Shutdown closes every session with CloseShutdown, refuses new joins and
// waits for the room goroutines to finish or for ctx to end.
func (h *Hub) Shutdown(ctx context.Context) error {
	h.mu.Lock()
	h.closed = true
	rooms := make([]*room, 0, len(h.rooms))
	for _, r := range h.rooms {
		rooms = append(rooms, r)
	}
	h.mu.Unlock()

	for _, r := range rooms {
		r.do(func(r *room) { r.closeAll(domain.CloseShutdown) })
	}
	done := make(chan struct{})
	go func() {
		h.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ActiveLocks returns the number of row locks currently held; the room sweeper removes expired ones.
func (h *Hub) ActiveLocks() int {
	h.lockMu.RLock()
	defer h.lockMu.RUnlock()
	return len(h.locks)
}

func (h *Hub) setLock(l domain.RowLock) {
	h.lockMu.Lock()
	h.locks[l.RowID] = l
	h.lockMu.Unlock()
}

func (h *Hub) clearLock(rowID string) {
	h.lockMu.Lock()
	delete(h.locks, rowID)
	h.lockMu.Unlock()
}
