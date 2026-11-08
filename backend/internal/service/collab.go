package service

import (
	"context"
	"fmt"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// Collab implements the authorization rules of realtime collaboration. It is
// stateless: the room state lives in the Hub behind CollabRooms, and the actor
// is passed on every call so a re-authenticated connection gets fresh rights.
type Collab struct {
	rooms  CollabRooms
	access ProjectAccess
	peers  PeerDirectory
	auth   TokenAuthenticator
}

// NewCollab wires the collaboration service.
func NewCollab(rooms CollabRooms, access ProjectAccess, peers PeerDirectory, auth TokenAuthenticator) *Collab {
	return &Collab{rooms: rooms, access: access, peers: peers, auth: auth}
}

// Authenticate verifies the token of a WebSocket auth frame.
func (c *Collab) Authenticate(ctx context.Context, token string) (domain.Actor, error) {
	return c.auth.Authenticate(ctx, token)
}

// ensureMember checks the rights every connection needs: viewing the project
// and its participant table.
func ensureMember(actor domain.Actor) error {
	if err := actor.Require(domain.PermProjectView); err != nil {
		return err
	}
	return actor.Require(domain.PermParticipantView)
}

// EnsureMember reports whether the actor may stay connected; the handler calls
// it again after every re-authentication.
func (c *Collab) EnsureMember(actor domain.Actor) error { return ensureMember(actor) }

// Join puts the actor into the room of the project. A project the actor cannot
// see is reported as ErrNotFound, missing permissions as ErrForbidden.
func (c *Collab) Join(ctx context.Context, actor domain.Actor, projectID string) (domain.RoomSession, error) {
	if err := ensureMember(actor); err != nil {
		return nil, err
	}
	if err := c.access.EnsureVisible(ctx, actor, projectID); err != nil {
		return nil, err
	}
	peer, err := c.peers.Peer(ctx, actor.UserID)
	if err != nil {
		return nil, fmt.Errorf("load peer card: %w", err)
	}
	peer.ID = actor.UserID
	sess, err := c.rooms.Join(ctx, projectID, peer)
	if err != nil {
		return nil, fmt.Errorf("join room: %w", err)
	}
	return sess, nil
}

// SetCursor publishes the actor's cursor.
func (c *Collab) SetCursor(actor domain.Actor, s domain.RoomSession, cur domain.Cursor) error {
	if err := ensureMember(actor); err != nil {
		return err
	}
	s.SetCursor(cur)
	return nil
}

// Acquire locks a row for editing; it needs participant.edit. A row held by
// another user yields ErrRowLocked with the owner in its details.
func (c *Collab) Acquire(actor domain.Actor, s domain.RoomSession, rowID string) (domain.LockInfo, error) {
	if err := actor.Require(domain.PermParticipantEdit); err != nil {
		return domain.LockInfo{}, err
	}
	return s.Acquire(rowID)
}

// Release drops the actor's lock on a row. Releasing needs no permission: a
// user who lost participant.edit must still be able to let go.
func (c *Collab) Release(s domain.RoomSession, rowID string) { s.Release(rowID) }

// Heartbeat renews the session's locks.
func (c *Collab) Heartbeat(s domain.RoomSession) { s.Heartbeat() }

// Shutdown ends all realtime sessions.
func (c *Collab) Shutdown(ctx context.Context) error { return c.rooms.Shutdown(ctx) }
