package service

import (
	"context"
	"errors"
	"testing"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

type fakeSession struct {
	domain.RoomSession
	cursor   domain.Cursor
	acquired []string
	released []string
	beats    int
}

func (s *fakeSession) SetCursor(c domain.Cursor) { s.cursor = c }
func (s *fakeSession) Acquire(row string) (domain.LockInfo, error) {
	s.acquired = append(s.acquired, row)
	return domain.LockInfo{By: "u1"}, nil
}
func (s *fakeSession) Release(row string) { s.released = append(s.released, row) }
func (s *fakeSession) Heartbeat()         { s.beats++ }

type fakeRooms struct {
	joined  domain.Peer
	project string
	err     error
	down    bool
}

func (r *fakeRooms) Join(_ context.Context, project string, p domain.Peer) (domain.RoomSession, error) {
	if r.err != nil {
		return nil, r.err
	}
	r.project, r.joined = project, p
	return &fakeSession{}, nil
}
func (r *fakeRooms) Shutdown(context.Context) error { r.down = true; return nil }

type fakeAccess struct{ err error }

func (a fakeAccess) EnsureVisible(context.Context, domain.Actor, string) error { return a.err }

type fakeDir struct{ err error }

func (d fakeDir) Peer(_ context.Context, id string) (domain.Peer, error) {
	return domain.Peer{ID: "ignored", DisplayName: "Name " + id, Color: "#fff"}, d.err
}

type fakeAuth struct{}

func (fakeAuth) Authenticate(_ context.Context, token string) (domain.Actor, error) {
	if token != "good" {
		return domain.Actor{}, domain.ErrUnauthenticated
	}
	return domain.Actor{UserID: "u1"}, nil
}

func actorWith(perms ...domain.Permission) domain.Actor {
	return domain.Actor{UserID: "u1", Perms: domain.NewPermissionSet(perms...)}
}

func TestCollabJoin(t *testing.T) {
	view := []domain.Permission{domain.PermProjectView, domain.PermParticipantView}
	tests := []struct {
		name    string
		actor   domain.Actor
		access  error
		dirErr  error
		roomErr error
		want    error
	}{
		{name: "ok", actor: actorWith(view...)},
		{name: "no project.view", actor: actorWith(domain.PermParticipantView), want: domain.ErrForbidden},
		{name: "no participant.view", actor: actorWith(domain.PermProjectView), want: domain.ErrForbidden},
		{name: "hidden project is 404", actor: actorWith(view...), access: domain.ErrNotFound, want: domain.ErrNotFound},
		{name: "directory failure", actor: actorWith(view...), dirErr: errors.New("db"), want: errors.New("db")},
		{name: "room failure", actor: actorWith(view...), roomErr: errors.New("closed"), want: errors.New("closed")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rooms := &fakeRooms{err: tt.roomErr}
			c := NewCollab(rooms, fakeAccess{tt.access}, fakeDir{tt.dirErr}, fakeAuth{})
			s, err := c.Join(context.Background(), tt.actor, "p1")
			switch {
			case tt.want == nil:
				if err != nil || s == nil {
					t.Fatalf("Join = %v, %v", s, err)
				}
				if rooms.project != "p1" || rooms.joined.ID != "u1" || rooms.joined.DisplayName != "Name u1" {
					t.Fatalf("joined %q as %+v", rooms.project, rooms.joined)
				}
			case errors.Is(tt.want, domain.ErrForbidden) || errors.Is(tt.want, domain.ErrNotFound):
				if !errors.Is(err, tt.want) {
					t.Fatalf("err = %v, want %v", err, tt.want)
				}
			default:
				if err == nil || errors.Is(err, domain.ErrForbidden) {
					t.Fatalf("err = %v, want a wrapped infrastructure error", err)
				}
			}
		})
	}
}

func TestCollabAcquireNeedsEdit(t *testing.T) {
	c := NewCollab(&fakeRooms{}, fakeAccess{}, fakeDir{}, fakeAuth{})
	s := &fakeSession{}
	if _, err := c.Acquire(context.Background(), actorWith(domain.PermParticipantView), s, "p1", "r1"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("viewer acquire = %v", err)
	}
	if len(s.acquired) != 0 {
		t.Fatal("session must not be touched without permission")
	}
	if _, err := c.Acquire(context.Background(), actorWith(domain.PermParticipantEdit), s, "p1", "r1"); err != nil || len(s.acquired) != 1 {
		t.Fatalf("editor acquire = %v, %v", err, s.acquired)
	}
}

func TestCollabCursorReleaseHeartbeatShutdown(t *testing.T) {
	rooms := &fakeRooms{}
	c := NewCollab(rooms, fakeAccess{}, fakeDir{}, fakeAuth{})
	s := &fakeSession{}
	viewer := actorWith(domain.PermProjectView, domain.PermParticipantView)

	if err := c.SetCursor(viewer, s, domain.Cursor{RowID: "r1"}); err != nil || s.cursor.RowID != "r1" {
		t.Fatalf("cursor = %v %+v", err, s.cursor)
	}
	if err := c.SetCursor(actorWith(), s, domain.Cursor{RowID: "r2"}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("cursor without rights = %v", err)
	}
	c.Release(s, "r1")
	c.Heartbeat(s)
	if len(s.released) != 1 || s.beats != 1 {
		t.Fatalf("released=%v beats=%d", s.released, s.beats)
	}
	if err := c.Shutdown(context.Background()); err != nil || !rooms.down {
		t.Fatalf("shutdown = %v down=%v", err, rooms.down)
	}
}

func TestCollabAuthenticate(t *testing.T) {
	c := NewCollab(&fakeRooms{}, fakeAccess{}, fakeDir{}, fakeAuth{})
	if a, err := c.Authenticate(context.Background(), "good"); err != nil || a.UserID != "u1" {
		t.Fatalf("good token = %+v, %v", a, err)
	}
	if _, err := c.Authenticate(context.Background(), "bad"); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("bad token = %v", err)
	}
}

func TestCollabRevalidate(t *testing.T) {
	view := actorWith(domain.PermProjectView, domain.PermParticipantView)
	if err := NewCollab(&fakeRooms{}, fakeAccess{}, fakeDir{}, fakeAuth{}).Revalidate(context.Background(), actorWith(domain.PermProjectView), "p1"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("missing participant.view = %v", err)
	}
	// A project that became invisible (for example finished, view_finished revoked) ends the connection.
	c := NewCollab(&fakeRooms{}, fakeAccess{domain.ErrNotFound}, fakeDir{}, fakeAuth{})
	if err := c.Revalidate(context.Background(), view, "p1"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("hidden project = %v", err)
	}
	c = NewCollab(&fakeRooms{}, fakeAccess{}, fakeDir{}, fakeAuth{})
	if err := c.Revalidate(context.Background(), view, "p1"); err != nil {
		t.Fatalf("visible project = %v", err)
	}
}

type fakeRows map[string]domain.Participant

func (f fakeRows) Get(_ context.Context, id string) (domain.Participant, error) {
	p, ok := f[id]
	if !ok {
		return domain.Participant{}, domain.ErrNotFound
	}
	return p, nil
}

func TestCollabAcquireChecksRowProject(t *testing.T) {
	rows := fakeRows{"mine": {ID: "mine", ProjectID: "p1"}, "foreign": {ID: "foreign", ProjectID: "p2"}}
	c := NewCollab(&fakeRooms{}, fakeAccess{}, fakeDir{}, fakeAuth{}).WithRows(rows)
	s := &fakeSession{}
	editor := actorWith(domain.PermParticipantEdit)
	for _, id := range []string{"foreign", "unknown"} {
		if _, err := c.Acquire(context.Background(), editor, s, "p1", id); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("acquire %s = %v, want not found", id, err)
		}
	}
	if len(s.acquired) != 0 {
		t.Fatalf("session touched for a foreign row: %v", s.acquired)
	}
	if _, err := c.Acquire(context.Background(), editor, s, "p1", "mine"); err != nil || len(s.acquired) != 1 {
		t.Fatalf("own row acquire = %v, %v", err, s.acquired)
	}
}
