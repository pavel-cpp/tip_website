package http

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

func (f *fakeProjects) Reorder(_ context.Context, _ domain.Actor, ids []string) error {
	f.reordered = ids
	return f.err
}

func TestReorderProjectsDecodesIDsAndReturns204(t *testing.T) {
	h, fake := newProjectsTestServer(t, 1<<20)
	a, b := uuid.NewString(), uuid.NewString()
	rec := call(h, http.MethodPut, "/projects/order", strings.NewReader(`{"ids":["`+a+`","`+b+`"]}`),
		map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if len(fake.reordered) != 2 || fake.reordered[0] != a || fake.reordered[1] != b {
		t.Fatalf("service got %v", fake.reordered)
	}
}

func TestProjectCardShowsOnlineUsers(t *testing.T) {
	h, fake := newProjectsTestServer(t, 1<<20)
	v := sampleView()
	v.Online = []domain.Peer{{ID: testUserID, DisplayName: "Alice", Color: "#ffb84d", AvatarURL: "/api/v1/users/x/avatar?v=1"}}
	fake.listOut = []service.ProjectView{v}
	rec := call(h, http.MethodGet, "/projects", nil, nil)
	var cards []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &cards); err != nil {
		t.Fatal(err)
	}
	if _, has := cards[0]["contributors"]; has {
		t.Fatal("cards must not carry contributors")
	}
	online := cards[0]["online"].([]any)
	if len(online) != 1 || online[0].(map[string]any)["displayName"] != "Alice" {
		t.Fatalf("online = %v", online)
	}
}
