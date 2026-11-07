package memory

import (
	"slices"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

type heldLock struct {
	lock   domain.RowLock
	member *member
}

type cursorEntry struct {
	cursor domain.Cursor
	member *member
}

// room is the actor of one project. All fields except id, inbox and done are
// touched only by the room goroutine (refs is guarded by Hub.mu).
type room struct {
	hub   *Hub
	id    string
	inbox chan func(*room)
	done  chan struct{}
	refs  int

	members  map[uint64]*member
	cursors  map[string]cursorEntry
	locks    map[string]heldLock
	pending  []*member // clients to remove after the current command
	finished bool
}

func newRoom(h *Hub, id string) *room {
	return &room{
		hub:     h,
		id:      id,
		inbox:   make(chan func(*room), roomInbox),
		done:    make(chan struct{}),
		members: make(map[uint64]*member),
		cursors: make(map[string]cursorEntry),
		locks:   make(map[string]heldLock),
	}
}

func (r *room) run() {
	defer r.hub.wg.Done()
	defer close(r.done)
	tick := time.NewTicker(r.hub.cfg.SweepInterval)
	defer tick.Stop()
	for {
		select {
		case fn := <-r.inbox:
			fn(r)
		case <-tick.C:
			r.sweep()
		}
		r.flush()
		if r.finished {
			return
		}
	}
}

// do queues a command for the room goroutine. It gives up when the room has exited.
func (r *room) do(fn func(*room)) {
	select {
	case r.inbox <- fn:
	case <-r.done:
	}
}

func (r *room) flush() {
	for len(r.pending) > 0 {
		m := r.pending[0]
		r.pending = r.pending[1:]
		r.remove(m)
	}
}

func (r *room) join(m *member) {
	r.members[m.id] = m
	first := r.sessionsOf(m.peer.ID) == 1
	m.snapshot = r.snapshot(m.peer.ID)
	r.hub.cfg.Metrics.ConnectionOpened()
	if first {
		r.broadcast(domain.PresenceEvent{Peers: r.peers()}, m)
	}
}

func (r *room) sessionsOf(userID string) int {
	n := 0
	for _, m := range r.members {
		if m.peer.ID == userID {
			n++
		}
	}
	return n
}

func (r *room) peers() []domain.Peer {
	seen := make(map[string]struct{}, len(r.members))
	out := make([]domain.Peer, 0, len(r.members))
	for _, m := range r.members {
		if _, dup := seen[m.peer.ID]; dup {
			continue
		}
		seen[m.peer.ID] = struct{}{}
		out = append(out, m.peer)
	}
	slices.SortFunc(out, func(a, b domain.Peer) int {
		if a.ID < b.ID {
			return -1
		}
		if a.ID > b.ID {
			return 1
		}
		return 0
	})
	return out
}

func (r *room) snapshot(you string) domain.RoomSnapshot {
	now := r.hub.cfg.Clock.Now()
	s := domain.RoomSnapshot{
		You:        you,
		Peers:      r.peers(),
		Cursors:    make(map[string]domain.Cursor, len(r.cursors)),
		Locks:      make(map[string]domain.LockInfo, len(r.locks)),
		ServerTime: now,
	}
	for uid, c := range r.cursors {
		s.Cursors[uid] = c.cursor
	}
	for row, l := range r.locks {
		if !l.lock.Expired(now) {
			s.Locks[row] = domain.LockInfo{By: l.lock.UserID, ExpiresAt: l.lock.ExpiresAt}
		}
	}
	return s
}

// send enqueues ev for m without blocking. A full buffer ends the session: a
// silent drop would leave the client with a wrong view of the table.
func (r *room) send(m *member, ev domain.Event) {
	if m.removed || m.isClosed() {
		return
	}
	select {
	case m.out <- ev:
		r.hub.cfg.Metrics.MessageOut(string(ev.EventType()))
	default:
		if m.closeWith(domain.CloseSlow) {
			r.hub.cfg.Metrics.SlowClientDisconnect()
			r.pending = append(r.pending, m)
		}
	}
}

func (r *room) broadcast(ev domain.Event, except *member) {
	for _, m := range r.members {
		if m != except {
			r.send(m, ev)
		}
	}
}

// remove takes m out of the room, releasing its locks and cursor, and ends the
// room goroutine when the last reference is gone.
func (r *room) remove(m *member) {
	if m.removed {
		return
	}
	m.removed = true
	delete(r.members, m.id)
	r.hub.cfg.Metrics.ConnectionClosed()

	for row, l := range r.locks {
		if l.member == m {
			r.unlock(row, l)
		}
	}
	if c, ok := r.cursors[m.peer.ID]; ok && c.member == m {
		delete(r.cursors, m.peer.ID)
		r.broadcast(domain.CursorEvent{UserID: m.peer.ID}, nil)
	}
	if r.sessionsOf(m.peer.ID) == 0 {
		r.broadcast(domain.PresenceEvent{Peers: r.peers()}, nil)
	}
	if r.hub.releaseRoom(r) {
		r.finished = true
	}
}

func (r *room) unlock(row string, l heldLock) {
	delete(r.locks, row)
	r.hub.clearLock(row)
	r.broadcast(domain.UnlockedEvent{RowID: row, By: l.lock.UserID, ExpiresAt: l.lock.ExpiresAt}, nil)
}

func (r *room) setCursor(m *member, c domain.Cursor) {
	if m.removed {
		return
	}
	if c.RowID == "" {
		c = domain.Cursor{}
		if cur, ok := r.cursors[m.peer.ID]; ok && cur.member == m {
			delete(r.cursors, m.peer.ID)
		}
	} else {
		r.cursors[m.peer.ID] = cursorEntry{cursor: c, member: m}
	}
	r.broadcast(domain.CursorEvent{UserID: m.peer.ID, Cursor: c}, m)
}

func (r *room) acquire(m *member, rowID string) (domain.LockInfo, error) {
	if m.removed {
		return domain.LockInfo{}, ErrHubClosed
	}
	now := r.hub.cfg.Clock.Now()
	cur, exists := r.locks[rowID]
	if exists && !cur.lock.Expired(now) {
		if err := cur.lock.EnsureAvailableTo(m.peer.ID, now); err != nil {
			r.hub.cfg.Metrics.LockConflict()
			return domain.LockInfo{}, err
		}
	}
	if !exists && r.heldBy(m) >= maxLocksPerSession {
		return domain.LockInfo{}, domain.NewValidation(domain.FieldError{Field: "rowId", Reason: "too many rows locked by one client"})
	}
	var l domain.RowLock
	if exists && !cur.lock.Expired(now) {
		l = cur.lock.Renew(now)
	} else {
		l = domain.NewRowLock(rowID, m.peer.ID, now)
	}
	r.locks[rowID] = heldLock{lock: l, member: m}
	r.hub.setLock(l)
	r.broadcast(domain.LockedEvent{RowID: rowID, By: l.UserID, ExpiresAt: l.ExpiresAt}, nil)
	return domain.LockInfo{By: l.UserID, ExpiresAt: l.ExpiresAt}, nil
}

func (r *room) heldBy(m *member) int {
	n := 0
	for _, l := range r.locks {
		if l.member == m {
			n++
		}
	}
	return n
}

func (r *room) release(m *member, rowID string) {
	if l, ok := r.locks[rowID]; ok && l.lock.OwnedBy(m.peer.ID) {
		r.unlock(rowID, l)
	}
}

// heartbeat renews the live locks of m and tells the room the new expiry, so
// other clients do not time the lock out on their own.
func (r *room) heartbeat(m *member) {
	now := r.hub.cfg.Clock.Now()
	for row, l := range r.locks {
		if l.member != m || l.lock.Expired(now) {
			continue
		}
		l.lock = l.lock.Renew(now)
		r.locks[row] = l
		r.hub.setLock(l.lock)
		r.broadcast(domain.LockedEvent{RowID: row, By: l.lock.UserID, ExpiresAt: l.lock.ExpiresAt}, nil)
	}
}

func (r *room) sweep() {
	now := r.hub.cfg.Clock.Now()
	for row, l := range r.locks {
		if l.lock.Expired(now) {
			r.unlock(row, l)
		}
	}
}

func (r *room) reauth(userID string) {
	for _, m := range r.members {
		if userID == "" || m.peer.ID == userID {
			r.send(m, domain.ReauthEvent{UserID: m.peer.ID})
		}
	}
}

func (r *room) kick(userID string) {
	for _, m := range r.members {
		if m.peer.ID == userID && m.closeWith(domain.CloseKicked) {
			r.pending = append(r.pending, m)
		}
	}
}

func (r *room) closeAll(reason domain.CloseReason) {
	for _, m := range r.members {
		if m.closeWith(reason) {
			r.pending = append(r.pending, m)
		}
	}
}
