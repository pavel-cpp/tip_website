package http

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

func TestActorContextRoundTrip(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if _, ok := ActorFrom(req.Context()); ok {
		t.Fatal("no actor expected in a fresh context")
	}
	want := domain.Actor{UserID: "u1"}
	got, ok := ActorFrom(WithActor(req.Context(), want))
	if !ok || got.UserID != "u1" {
		t.Fatalf("actor = %+v, ok = %v", got, ok)
	}
}

func TestActorOrFailWritesUnauthenticated(t *testing.T) {
	rec := httptest.NewRecorder()
	if _, ok := actorOrFail(rec, httptest.NewRequest(http.MethodGet, "/", nil)); ok {
		t.Fatal("expected failure without an actor")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestDecodeJSON(t *testing.T) {
	type body struct {
		Name string `json:"name"`
	}
	tests := []struct {
		name    string
		payload string
		want    error // matched with errors.Is; nil means success
	}{
		{"valid", `{"name":"a"}`, nil},
		{"empty", ``, domain.ErrValidation},
		{"malformed", `{"name":`, domain.ErrValidation},
		{"unknown field", `{"nope":1}`, domain.ErrValidation},
		{"trailing data", `{"name":"a"} {"name":"b"}`, domain.ErrValidation},
		{"too large", `{"name":"` + strings.Repeat("x", maxJSONBody) + `"}`, domain.ErrTooLarge},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.payload))
			var b body
			err := decodeJSON(rec, req, &b)
			if tc.want == nil {
				if err != nil || b.Name != "a" {
					t.Fatalf("err = %v, body = %+v", err, b)
				}
				return
			}
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}
