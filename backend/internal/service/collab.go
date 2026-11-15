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
	rows   CollabRows // optional, see WithRows
}

// NewCollab wires the collaboration service.
func NewCollab(rooms CollabRooms, access ProjectAccess, peers PeerDirectory, auth TokenAuthenticator) *Collab {
	return &Collab{rooms: rooms, access: access, peers: peers, auth: auth}
}

// WithRows enables the check that a lock request names a row of the room's project. It is
// optional so the service stays usable without a participant store; the hub scopes locks by
// project either way, so a foreign row id can never affect another room.
func (c *Collab) WithRows(rows CollabRows) *Collab {
	c.rows = rows
	return c
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

// Revalidate applies the join rules again to a re-authenticated actor: the rights every
// connection needs plus the visibility of the project (a finished project needs
// project.view_finished), so a revoked permission ends the connection.
func (c *Collab) Revalidate(ctx context.Context, actor domain.Actor, projectID string) error {
	if err := ensureMember(actor); err != nil {
		return err
	}
	return c.access.EnsureVisible(ctx, actor, projectID)
}

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

// Acquire locks a row for editing; it needs participant.edit and, when WithRows is set, a row
// of the room's project (ErrNotFound otherwise). The lookup runs only here, never per cursor
// frame. A row held by another user yields ErrRowLocked with the owner in its details.
func (c *Collab) Acquire(ctx context.Context, actor domain.Actor, s domain.RoomSession, projectID, rowID string) (domain.LockInfo, error) {
	if err := actor.Require(domain.PermParticipantEdit); err != nil {
		return domain.LockInfo{}, err
	}
	if c.rows != nil {
		row, err := c.rows.Get(ctx, rowID)
		if err != nil {
			return domain.LockInfo{}, err
		}
		if row.ProjectID != projectID {
			return domain.LockInfo{}, domain.ErrNotFound
		}
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
