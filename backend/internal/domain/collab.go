package domain

import "time"

// Realtime collaboration types (docs/04-api.md, section 7). They live in domain
// because the in-memory Hub (repository) and the WebSocket handler talk to each
// other only through service ports that must be expressed in shared types.

// Realtime event types produced by the Hub itself (in addition to the domain
// events declared in event.go).
const (
	EventPresence EventType = "presence"
	EventCursor   EventType = "cursor"
	EventLock     EventType = "lock"
	EventUnlock   EventType = "unlock"
)

// Peer is a user present in a project room. Several browser tabs of one user
// are a single peer.
type Peer struct {
	ID          string
	DisplayName string
	Color       string
	AvatarURL   string
}

// Cursor is the cell a user is looking at. An empty RowID means "no cursor".
type Cursor struct {
	RowID string
	Field string
}

// LockInfo describes a live row lock as other clients see it.
type LockInfo struct {
	By        string
	ExpiresAt time.Time
}

// RoomSnapshot is the state a client receives right after joining.
type RoomSnapshot struct {
	You        string
	Peers      []Peer
	Cursors    map[string]Cursor
	Locks      map[string]LockInfo
	ServerTime time.Time
}

// PresenceEvent announces the new set of online peers.
type PresenceEvent struct{ Peers []Peer }

// CursorEvent announces another user's cursor; a zero Cursor clears it.
type CursorEvent struct {
	UserID string
	Cursor Cursor
}

// LockedEvent announces that a row is locked (or that the lock was renewed).
type LockedEvent struct {
	RowID     string
	By        string
	ExpiresAt time.Time
}

// UnlockedEvent announces that a row lock was released or expired.
type UnlockedEvent struct {
	RowID     string
	By        string
	ExpiresAt time.Time
}

// EventType implements Event.
func (PresenceEvent) EventType() EventType { return EventPresence }

// EventType implements Event.
func (CursorEvent) EventType() EventType { return EventCursor }

// EventType implements Event.
func (LockedEvent) EventType() EventType { return EventLock }

// EventType implements Event.
func (UnlockedEvent) EventType() EventType { return EventUnlock }

// CloseReason says why the Hub ended a session.
type CloseReason int

// Close reasons; the transport maps them to WebSocket close codes.
const (
	// CloseNone means the session is still open or the client left on its own.
	CloseNone CloseReason = iota
	// CloseSlow: the client could not keep up with the send buffer (1013).
	CloseSlow
	// CloseKicked: the user was deactivated or lost access (1008).
	CloseKicked
	// CloseShutdown: the server is restarting (1001).
	CloseShutdown
)

// RoomSession is one client's membership in a project room. All methods are
// safe for concurrent use. Events are delivered in order through Events; when
// the Hub ends the session it closes Closed and CloseReason says why.
type RoomSession interface {
	// Snapshot is the room state at the moment of joining.
	Snapshot() RoomSnapshot
	// Events carries room broadcasts. The channel is never closed; watch Closed.
	Events() <-chan Event
	// Closed is closed when the Hub ends the session (slow client, kick, shutdown).
	Closed() <-chan struct{}
	// CloseReason is valid once Closed is closed.
	CloseReason() CloseReason
	// Allow consumes one unit of the per-client message budget and reports
	// whether the message may be processed.
	Allow() bool
	// SetCursor publishes the user's cursor; a zero Cursor clears it.
	SetCursor(c Cursor)
	// Acquire locks a row for the session's user. A row held by someone else
	// yields an error built by NewRowLocked.
	Acquire(rowID string) (LockInfo, error)
	// Release drops the user's lock on a row, if any.
	Release(rowID string)
	// Heartbeat renews every lock the session holds.
	Heartbeat()
	// Leave removes the session from its room; it is idempotent.
	Leave()
}
