package http

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// maxJSONBody bounds JSON request bodies; file uploads use their own, larger limits.
const maxJSONBody = 1 << 20

type actorKey struct{}

// WithActor stores the authenticated actor in the context (set by the authentication middleware).
func WithActor(ctx context.Context, a domain.Actor) context.Context {
	return context.WithValue(ctx, actorKey{}, a)
}

// ActorFrom returns the authenticated actor stored by WithActor.
func ActorFrom(ctx context.Context) (domain.Actor, bool) {
	a, ok := ctx.Value(actorKey{}).(domain.Actor)
	return a, ok
}

// actorOrFail returns the actor of the request. When there is none it writes the 401 envelope
// and reports false, so a handler can simply return.
func actorOrFail(w http.ResponseWriter, r *http.Request) (domain.Actor, bool) {
	a, ok := ActorFrom(r.Context())
	if !ok {
		fail(w, r, domain.ErrUnauthenticated)
	}
	return a, ok
}

// decodeJSON reads a size-limited JSON body into v. Unknown fields are rejected so client
// typos surface as validation errors instead of being silently ignored.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxJSONBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var tooLarge *http.MaxBytesError
		switch {
		case errors.As(err, &tooLarge):
			return domain.ErrTooLarge
		case errors.Is(err, io.EOF):
			return domain.NewValidation(domain.FieldError{Field: "body", Reason: "request body is required"})
		default:
			return domain.NewValidation(domain.FieldError{Field: "body", Reason: "malformed JSON or unknown field"})
		}
	}
	if dec.More() {
		return domain.NewValidation(domain.FieldError{Field: "body", Reason: "unexpected data after JSON value"})
	}
	return nil
}
