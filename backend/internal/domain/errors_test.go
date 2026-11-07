package domain

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestSentinelCodes(t *testing.T) {
	tests := []struct {
		err  *Error
		code Code
	}{
		{ErrNotFound, "NOT_FOUND"},
		{ErrForbidden, "FORBIDDEN"},
		{ErrUnauthenticated, "UNAUTHENTICATED"},
		{ErrAuthUnavailable, "AUTH_UNAVAILABLE"},
		{ErrTokenExpired, "TOKEN_EXPIRED"},
		{ErrTokenStale, "TOKEN_STALE"},
		{ErrRefreshInvalid, "REFRESH_INVALID"},
		{ErrBadCredentials, "BAD_CREDENTIALS"},
		{ErrPasswordChangeReq, "PASSWORD_CHANGE_REQUIRED"},
		{ErrRowLocked, "ROW_LOCKED"},
		{ErrVersionConflict, "VERSION_CONFLICT"},
		{ErrProjectFinished, "PROJECT_FINISHED"},
		{ErrLastAdmin, "LAST_ADMIN"},
		{ErrRoleInUse, "ROLE_IN_USE"},
		{ErrRoleSystem, "ROLE_SYSTEM"},
		{ErrTooLarge, "TOO_LARGE"},
		{ErrUnsupportedMedia, "UNSUPPORTED_MEDIA"},
		{ErrImageInvalid, "IMAGE_INVALID"},
		{ErrRateLimited, "RATE_LIMITED"},
		{ErrDiskLow, "DISK_LOW"},
		{ErrValidation, "VALIDATION"},
	}
	seen := map[Code]bool{}
	for _, tt := range tests {
		t.Run(string(tt.code), func(t *testing.T) {
			if tt.err.Code != tt.code {
				t.Fatalf("code = %q, want %q", tt.err.Code, tt.code)
			}
			if got := CodeOf(tt.err); got != tt.code {
				t.Fatalf("CodeOf = %q", got)
			}
			if tt.err.Error() == "" {
				t.Fatal("empty message")
			}
			if seen[tt.code] {
				t.Fatalf("duplicate code %q", tt.code)
			}
			seen[tt.code] = true
		})
	}
}

func TestErrorsIsAndWrapping(t *testing.T) {
	wrapped := fmt.Errorf("service: %w", fmt.Errorf("repo: %w", ErrNotFound))
	if !errors.Is(wrapped, ErrNotFound) {
		t.Fatal("wrapped sentinel must match")
	}
	if errors.Is(wrapped, ErrForbidden) {
		t.Fatal("different codes must not match")
	}
	if CodeOf(wrapped) != CodeNotFound {
		t.Fatalf("CodeOf(wrapped) = %q", CodeOf(wrapped))
	}
}

func TestDetailCarryingErrors(t *testing.T) {
	tests := []struct {
		name    string
		err     error
		is      *Error
		detail  string
		wantVal any
	}{
		{"row locked", NewRowLocked("u1"), ErrRowLocked, "by", "u1"},
		{"version conflict", NewVersionConflict(42), ErrVersionConflict, "current", 42},
		{"rate limited", NewRateLimited(3 * time.Second), ErrRateLimited, "retryAfter", 3 * time.Second},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			wrapped := fmt.Errorf("ctx: %w", tt.err)
			if !errors.Is(wrapped, tt.is) {
				t.Fatal("must match its sentinel")
			}
			var de *Error
			if !errors.As(wrapped, &de) {
				t.Fatal("errors.As failed")
			}
			if de.Details[tt.detail] != tt.wantVal {
				t.Fatalf("detail %q = %v, want %v", tt.detail, de.Details[tt.detail], tt.wantVal)
			}
		})
	}

	inUse := NewRoleInUse([]string{"a", "b"})
	var de *Error
	if !errors.As(inUse, &de) || !errors.Is(inUse, ErrRoleInUse) {
		t.Fatal("role in use must match")
	}
	if users, _ := de.Details["users"].([]string); len(users) != 2 {
		t.Fatalf("users detail = %v", de.Details["users"])
	}
}

func TestValidationError(t *testing.T) {
	err := error(NewValidation(FieldError{"login", "bad"}, FieldError{"name", "short"}))
	wrapped := fmt.Errorf("create user: %w", err)

	if !errors.Is(wrapped, ErrValidation) {
		t.Fatal("must match ErrValidation")
	}
	if errors.Is(wrapped, ErrNotFound) {
		t.Fatal("must not match other codes")
	}
	var ve *ValidationError
	if !errors.As(wrapped, &ve) || len(ve.Fields) != 2 || ve.Fields[0].Field != "login" {
		t.Fatalf("errors.As = %+v", ve)
	}
	if CodeOf(wrapped) != CodeValidation {
		t.Fatalf("CodeOf = %q", CodeOf(wrapped))
	}
	want := "validation failed: login: bad; name: short"
	if ve.Error() != want {
		t.Fatalf("Error() = %q, want %q", ve.Error(), want)
	}
}

func TestCodeOf(t *testing.T) {
	if CodeOf(nil) != "" {
		t.Fatal("nil must yield empty code")
	}
	if CodeOf(errors.New("boom")) != CodeInternal {
		t.Fatal("foreign errors must map to INTERNAL")
	}
}

func TestCollect(t *testing.T) {
	if collect(nil, nil) != nil {
		t.Fatal("no errors must collect to nil")
	}
	err := collect(fieldError("a", "x"), nil, fieldError("b", "y"), errors.New("ignored"))
	var ve *ValidationError
	if !errors.As(err, &ve) || len(ve.Fields) != 2 {
		t.Fatalf("collect = %v", err)
	}
}
