package service

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

func (r *fakeRepo) Reorder(_ context.Context, ids []string, activeOnly bool) error {
	r.reorderIDs, r.reorderActiveOnly = ids, activeOnly
	return nil
}

type fakePresence map[string][]domain.Peer

func (p fakePresence) Online(_ context.Context, _ []string) map[string][]domain.Peer { return p }

func TestReorderNeedsUpdateAndAudits(t *testing.T) {
	e := newEnv()
	ctx := context.Background()
	if err := e.svc.Reorder(ctx, viewer, []string{"a"}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("viewer: %v", err)
	}
	if err := e.svc.Reorder(ctx, admin, []string{"a", "b"}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(e.repo.reorderIDs, []string{"a", "b"}) || e.repo.reorderActiveOnly {
		t.Fatalf("repo got %v activeOnly=%v", e.repo.reorderIDs, e.repo.reorderActiveOnly)
	}
	if got := e.audit.actions(); !slices.Equal(got, []string{ActionProjectReorder}) {
		t.Fatalf("audit = %v", got)
	}
	// Without project.view_finished the finished projects must stay out of the reorder.
	editor := actor(domain.PermProjectView, domain.PermProjectUpdate)
	if err := e.svc.Reorder(ctx, editor, []string{"a"}); err != nil || !e.repo.reorderActiveOnly {
		t.Fatalf("editor: err=%v activeOnly=%v", err, e.repo.reorderActiveOnly)
	}
	if err := e.svc.Reorder(ctx, admin, make([]string, maxReorderIDs+1)); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("too many ids: %v", err)
	}
}

func TestListAttachesOnlineUsers(t *testing.T) {
	e := newEnv()
	v := mustCreate(t, e, "P")
	e.svc.d.Presence = fakePresence{v.ID: {{ID: "u9", DisplayName: "Zed"}}}
	got, err := e.svc.List(context.Background(), admin, domain.ProjectFilter{})
	if err != nil || len(got) != 1 || len(got[0].Online) != 1 || got[0].Online[0].ID != "u9" {
		t.Fatalf("list = %+v err=%v", got, err)
	}
}
