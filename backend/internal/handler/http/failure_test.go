package http

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

func decodeEnvelope(t *testing.T, rec *httptest.ResponseRecorder) errorEnvelope {
	t.Helper()
	var env errorEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode envelope: %v (body %q)", err, rec.Body.String())
	}
	return env
}

func TestFailStatusPerSentinel(t *testing.T) {
	tests := []struct {
		err    error
		status int
		code   string
	}{
		{domain.ErrNotFound, http.StatusNotFound, "NOT_FOUND"},
		{domain.ErrForbidden, http.StatusForbidden, "FORBIDDEN"},
		{domain.ErrUnauthenticated, http.StatusUnauthorized, "UNAUTHENTICATED"},
		{domain.ErrTokenExpired, http.StatusUnauthorized, "TOKEN_EXPIRED"},
		{domain.ErrTokenStale, http.StatusUnauthorized, "TOKEN_STALE"},
		{domain.ErrRefreshInvalid, http.StatusUnauthorized, "REFRESH_INVALID"},
		{domain.ErrBadCredentials, http.StatusUnauthorized, "BAD_CREDENTIALS"},
		{domain.ErrAuthUnavailable, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE"},
		{domain.ErrPasswordChangeReq, http.StatusForbidden, "PASSWORD_CHANGE_REQUIRED"},
		{domain.ErrProjectFinished, http.StatusConflict, "PROJECT_FINISHED"},
		{domain.ErrLastAdmin, http.StatusConflict, "LAST_ADMIN"},
		{domain.ErrRoleSystem, http.StatusConflict, "ROLE_SYSTEM"},
		{domain.ErrTooLarge, http.StatusRequestEntityTooLarge, "TOO_LARGE"},
		{domain.ErrUnsupportedMedia, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA"},
		{domain.ErrImageInvalid, http.StatusUnprocessableEntity, "IMAGE_INVALID"},
		{domain.ErrDiskLow, http.StatusInsufficientStorage, "DISK_LOW"},
		{fmt.Errorf("wrapped: %w", domain.ErrNotFound), http.StatusNotFound, "NOT_FOUND"},
	}
	for _, tc := range tests {
		t.Run(tc.code, func(t *testing.T) {
			rec := httptest.NewRecorder()
			fail(rec, httptest.NewRequest(http.MethodGet, "/", nil), tc.err)
			if rec.Code != tc.status {
				t.Errorf("status = %d, want %d", rec.Code, tc.status)
			}
			if got := decodeEnvelope(t, rec).Error.Code; got != tc.code {
				t.Errorf("code = %q, want %q", got, tc.code)
			}
		})
	}
}

func TestFailValidationDetails(t *testing.T) {
	rec := httptest.NewRecorder()
	err := domain.NewValidation(domain.FieldError{Field: "name", Reason: "too long"})
	fail(rec, httptest.NewRequest(http.MethodPost, "/", nil), err)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
	details, _ := decodeEnvelope(t, rec).Error.Details.(map[string]any)
	fields, _ := details["fields"].([]any)
	if len(fields) != 1 {
		t.Fatalf("details = %v", details)
	}
	first, _ := fields[0].(map[string]any)
	if first["field"] != "name" || first["reason"] != "too long" {
		t.Errorf("field detail = %v", first)
	}
}

func TestFailConflictDetails(t *testing.T) {
	rec := httptest.NewRecorder()
	fail(rec, httptest.NewRequest(http.MethodPatch, "/", nil), domain.NewRowLocked("user-7"))

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d", rec.Code)
	}
	details, _ := decodeEnvelope(t, rec).Error.Details.(map[string]any)
	if details["by"] != "user-7" {
		t.Errorf("details = %v", details)
	}
}

func TestFailRateLimitedSetsRetryAfter(t *testing.T) {
	rec := httptest.NewRecorder()
	fail(rec, httptest.NewRequest(http.MethodPost, "/", nil), domain.NewRateLimited(90*time.Second+time.Millisecond))

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "91" {
		t.Errorf("Retry-After = %q, want 91", got)
	}
	details, _ := decodeEnvelope(t, rec).Error.Details.(map[string]any)
	if _, leaked := details["retryAfter"]; leaked {
		t.Error("raw duration must not be serialized")
	}
}

func TestFailUnknownErrorDoesNotLeak(t *testing.T) {
	rec := httptest.NewRecorder()
	fail(rec, httptest.NewRequest(http.MethodGet, "/", nil), errors.New(`pq: duplicate key value "+7 926 000-00-00"`))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
	env := decodeEnvelope(t, rec)
	if env.Error.Code != "INTERNAL" {
		t.Errorf("code = %q", env.Error.Code)
	}
	if body := rec.Body.String(); strings.Contains(body, "duplicate key") || strings.Contains(body, "+7 926") {
		t.Errorf("internal error text leaked to the client: %s", body)
	}
}
