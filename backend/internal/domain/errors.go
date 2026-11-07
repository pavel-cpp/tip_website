// Package domain holds the entities, rules, permission catalog and errors of
// the TIP application. It imports the standard library only and performs no
// I/O, logging or clock reads: callers pass the current time explicitly.
package domain

import (
	"errors"
	"strings"
	"time"
)

// Code is a stable machine-readable error code. The values are part of the
// public API contract (docs/04-api.md, section 1) and must never change.
type Code string

// Error codes returned to API clients.
const (
	CodeValidation        Code = "VALIDATION"
	CodeUnauthenticated   Code = "UNAUTHENTICATED"
	CodeAuthUnavailable   Code = "AUTH_UNAVAILABLE"
	CodeTokenExpired      Code = "TOKEN_EXPIRED"
	CodeTokenStale        Code = "TOKEN_STALE"
	CodeRefreshInvalid    Code = "REFRESH_INVALID"
	CodeBadCredentials    Code = "BAD_CREDENTIALS"
	CodeForbidden         Code = "FORBIDDEN"
	CodePasswordChangeReq Code = "PASSWORD_CHANGE_REQUIRED"
	CodeNotFound          Code = "NOT_FOUND"
	CodeRowLocked         Code = "ROW_LOCKED"
	CodeVersionConflict   Code = "VERSION_CONFLICT"
	CodeProjectFinished   Code = "PROJECT_FINISHED"
	CodeLastAdmin         Code = "LAST_ADMIN"
	CodeRoleInUse         Code = "ROLE_IN_USE"
	CodeRoleSystem        Code = "ROLE_SYSTEM"
	CodeTooLarge          Code = "TOO_LARGE"
	CodeUnsupportedMedia  Code = "UNSUPPORTED_MEDIA"
	CodeImageInvalid      Code = "IMAGE_INVALID"
	CodeRateLimited       Code = "RATE_LIMITED"
	CodeDiskLow           Code = "DISK_LOW"
	CodeInternal          Code = "INTERNAL"
)

// Coder is implemented by every domain error and exposes its stable code.
type Coder interface {
	error
	ErrorCode() Code
}

// Error is a domain error identified by its Code. Two Errors match under
// errors.Is when their codes are equal, so a sentinel such as ErrRowLocked
// matches every error built by NewRowLocked regardless of its details.
type Error struct {
	Code    Code
	Message string
	// Details carries optional structured context (for example the lock owner)
	// that the transport layer may expose to clients. It never holds personal data.
	Details map[string]any
}

// Error implements the error interface.
func (e *Error) Error() string { return e.Message }

// ErrorCode implements Coder.
func (e *Error) ErrorCode() Code { return e.Code }

// Is reports whether target is a domain *Error with the same code.
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && t.Code == e.Code
}

// Sentinel errors. Compare with errors.Is, never with ==, because wrapping
// and detail-carrying variants are expected.
var (
	ErrNotFound          = &Error{Code: CodeNotFound, Message: "resource not found"}
	ErrForbidden         = &Error{Code: CodeForbidden, Message: "permission denied"}
	ErrUnauthenticated   = &Error{Code: CodeUnauthenticated, Message: "authentication required"}
	ErrAuthUnavailable   = &Error{Code: CodeAuthUnavailable, Message: "authentication backend unavailable"}
	ErrTokenExpired      = &Error{Code: CodeTokenExpired, Message: "access token expired"}
	ErrTokenStale        = &Error{Code: CodeTokenStale, Message: "access token permissions are stale"}
	ErrRefreshInvalid    = &Error{Code: CodeRefreshInvalid, Message: "refresh token is invalid"}
	ErrBadCredentials    = &Error{Code: CodeBadCredentials, Message: "invalid login or password"}
	ErrPasswordChangeReq = &Error{Code: CodePasswordChangeReq, Message: "password change required"}
	ErrRowLocked         = &Error{Code: CodeRowLocked, Message: "row is being edited by another user"}
	ErrVersionConflict   = &Error{Code: CodeVersionConflict, Message: "row version is outdated"}
	ErrProjectFinished   = &Error{Code: CodeProjectFinished, Message: "project is finished and read-only"}
	ErrLastAdmin         = &Error{Code: CodeLastAdmin, Message: "the last active administrator cannot be removed"}
	ErrRoleInUse         = &Error{Code: CodeRoleInUse, Message: "role is assigned to users"}
	ErrRoleSystem        = &Error{Code: CodeRoleSystem, Message: "operation is not allowed on a system role"}
	ErrTooLarge          = &Error{Code: CodeTooLarge, Message: "payload too large"}
	ErrUnsupportedMedia  = &Error{Code: CodeUnsupportedMedia, Message: "unsupported media type"}
	ErrImageInvalid      = &Error{Code: CodeImageInvalid, Message: "image is invalid"}
	ErrRateLimited       = &Error{Code: CodeRateLimited, Message: "too many requests"}
	ErrDiskLow           = &Error{Code: CodeDiskLow, Message: "not enough free disk space"}
	// ErrValidation matches every *ValidationError under errors.Is.
	ErrValidation = &Error{Code: CodeValidation, Message: "validation failed"}
)

// NewRowLocked reports that the row is locked by user `by`.
func NewRowLocked(by string) error {
	return &Error{Code: CodeRowLocked, Message: ErrRowLocked.Message, Details: map[string]any{"by": by}}
}

// NewVersionConflict reports a stale version; current is the up-to-date row
// that the client should adopt.
func NewVersionConflict(current any) error {
	return &Error{Code: CodeVersionConflict, Message: ErrVersionConflict.Message, Details: map[string]any{"current": current}}
}

// NewRoleInUse reports that the role is still assigned to the given users.
func NewRoleInUse(users []string) error {
	return &Error{Code: CodeRoleInUse, Message: ErrRoleInUse.Message, Details: map[string]any{"users": users}}
}

// NewRateLimited reports a throttled request; the transport layer turns
// retryAfter into the Retry-After header.
func NewRateLimited(retryAfter time.Duration) error {
	return &Error{Code: CodeRateLimited, Message: ErrRateLimited.Message, Details: map[string]any{"retryAfter": retryAfter}}
}

// FieldError describes one invalid input field.
type FieldError struct {
	Field  string
	Reason string
}

// ValidationError is returned for invalid input and lists every offending field.
type ValidationError struct {
	Fields []FieldError
}

// NewValidation builds a ValidationError from the given field errors.
func NewValidation(fields ...FieldError) *ValidationError {
	return &ValidationError{Fields: fields}
}

// fieldError is a shorthand for a validation error on a single field.
func fieldError(field, reason string) *ValidationError {
	return NewValidation(FieldError{Field: field, Reason: reason})
}

// Error implements the error interface. It lists field names and reasons only,
// never the submitted values, so it is safe to log.
func (e *ValidationError) Error() string {
	parts := make([]string, len(e.Fields))
	for i, f := range e.Fields {
		parts[i] = f.Field + ": " + f.Reason
	}
	return "validation failed: " + strings.Join(parts, "; ")
}

// ErrorCode implements Coder.
func (e *ValidationError) ErrorCode() Code { return CodeValidation }

// Is makes every ValidationError match ErrValidation.
func (e *ValidationError) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && t.Code == CodeValidation
}

// collect merges validation errors into one; it returns nil when none failed.
// Non-validation errors are not expected here and are ignored by design: the
// validators it is fed return only *ValidationError or nil.
func collect(errs ...error) error {
	var fields []FieldError
	for _, err := range errs {
		var ve *ValidationError
		if errors.As(err, &ve) {
			fields = append(fields, ve.Fields...)
		}
	}
	if len(fields) == 0 {
		return nil
	}
	return NewValidation(fields...)
}

// CodeOf returns the stable code of err, or CodeInternal when err carries none.
// A nil error yields the empty code.
func CodeOf(err error) Code {
	if err == nil {
		return ""
	}
	var c Coder
	if errors.As(err, &c) {
		return c.ErrorCode()
	}
	return CodeInternal
}
