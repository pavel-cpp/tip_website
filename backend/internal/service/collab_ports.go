package service

import (
	"context"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// CollabRooms is the realtime room registry, implemented by repository/memory.Hub.
type CollabRooms interface {
	// Join adds a client to the room of the project.
	Join(ctx context.Context, projectID string, peer domain.Peer) (domain.RoomSession, error)
	// Shutdown ends every session with CloseShutdown and waits for the rooms to stop.
	Shutdown(ctx context.Context) error
}

// ProjectAccess answers whether a project exists and is visible to the actor
// (docs/02-architecture.md, section 5.4: hidden projects are 404). It is
// implemented by the projects stream.
type ProjectAccess interface {
	// EnsureVisible returns domain.ErrNotFound when the actor must not see the project.
	EnsureVisible(ctx context.Context, actor domain.Actor, projectID string) error
}

// PeerDirectory supplies the presence card (name, colour, avatar) of a user.
type PeerDirectory interface {
	Peer(ctx context.Context, userID string) (domain.Peer, error)
}

// TokenAuthenticator verifies an access token received in a WebSocket auth
// frame and returns the actor built from its claims. It must apply the same
// checks as the HTTP middleware: signature, exp, revocation and permission epoch.
type TokenAuthenticator interface {
	Authenticate(ctx context.Context, token string) (domain.Actor, error)
}
