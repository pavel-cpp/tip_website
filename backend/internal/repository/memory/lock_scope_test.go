package memory

import (
	"context"
	"errors"
	"testing"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// A lock taken in one room must not be visible to, or clearable from, another room that uses the same row id.
func TestLocksAreScopedByProject(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a := h.join("pA", "alice")
	b := h.join("pB", "bob")
	if _, err := a.Acquire("shared-row"); err != nil {
		t.Fatal(err)
	}
	if err := h.hub.EnsureFree(ctx, "pA", "shared-row", "bob"); !errors.Is(err, domain.ErrRowLocked) {
		t.Fatalf("EnsureFree in the locking room = %v, want ROW_LOCKED", err)
	}
	if err := h.hub.EnsureFree(ctx, "pB", "shared-row", "bob"); err != nil {
		t.Fatalf("EnsureFree in another room = %v, want nil", err)
	}
	// The same row id in the other room is an independent lock.
	if _, err := b.Acquire("shared-row"); err != nil {
		t.Fatalf("acquire in the other room: %v", err)
	}
	if got := h.hub.ActiveLocks(); got != 2 {
		t.Fatalf("active locks = %d, want 2", got)
	}
	a.Release("shared-row")
	eventually(t, func() bool { return h.hub.ActiveLocks() == 1 }, "release clears only its own room's lock")
	if err := h.hub.EnsureFree(ctx, "pB", "shared-row", "alice"); !errors.Is(err, domain.ErrRowLocked) {
		t.Fatalf("lock of the other room vanished: %v", err)
	}
}
