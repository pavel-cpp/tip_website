package memory

import (
	"context"
	"testing"
)

func TestOnlineListsConnectedUsersPerProject(t *testing.T) {
	h := newHarness(t, nil)
	h.join("p1", "bob")
	a := h.join("p1", "alice")
	tab2 := h.join("p1", "alice")
	h.join("p2", "carol")

	got := h.hub.Online(context.Background(), []string{"p1", "p2", "empty"})
	if len(got["p1"]) != 2 || got["p1"][0].ID != "alice" || got["p1"][1].ID != "bob" {
		t.Fatalf("p1 = %+v, want alice and bob once each", got["p1"])
	}
	if len(got["p2"]) != 1 || got["p2"][0].ID != "carol" {
		t.Fatalf("p2 = %+v", got["p2"])
	}
	if _, ok := got["empty"]; ok {
		t.Fatal("a project without a room must be absent")
	}

	tab2.Leave()
	a.Leave()
	eventually(t, func() bool {
		return len(h.hub.Online(context.Background(), []string{"p1"})["p1"]) == 1
	}, "alice disappears after both tabs left")
}
