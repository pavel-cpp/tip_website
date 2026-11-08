package http

import (
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

// authMultipartOverhead is the allowance for multipart framing on top of the file limit.
const authMultipartOverhead = 64 << 10

func authUUID(s string) uuid.UUID {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil
	}
	return id
}

func authStr[T ~string](p *T) *string {
	if p == nil {
		return nil
	}
	s := string(*p)
	return &s
}

// GetMe implements GET /me.
func (a *AuthAPI) GetMe(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	p, err := a.d.Users.Me(r.Context(), actor)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, gen.UserResponse{User: authUserDTO(p)})
}

// UpdateMe implements PATCH /me.
func (a *AuthAPI) UpdateMe(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	var body gen.UpdateMeRequest
	if err := decodeJSON(w, r, &body); err != nil {
		fail(w, r, err)
		return
	}
	p, err := a.d.Users.UpdateProfile(r.Context(), actor, service.ProfileUpdate{
		DisplayName: body.DisplayName, Color: body.Color, Locale: authStr(body.Locale), Theme: authStr(body.Theme),
	})
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, gen.UserResponse{User: authUserDTO(p)})
}

// PutMyAvatar implements PUT /me/avatar.
func (a *AuthAPI) PutMyAvatar(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	raw, err := authReadUpload(w, r, "file", service.MaxAvatarUpload)
	if err != nil {
		fail(w, r, err)
		return
	}
	p, err := a.d.Users.SetAvatar(r.Context(), actor, raw)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, gen.UserResponse{User: authUserDTO(p)})
}

// authReadUpload reads one multipart file field of at most limit bytes into memory.
func authReadUpload(w http.ResponseWriter, r *http.Request, field string, limit int64) ([]byte, error) {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		return nil, domain.ErrUnsupportedMedia
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit+authMultipartOverhead)
	if err := r.ParseMultipartForm(limit + authMultipartOverhead); err != nil { //nolint:gosec // the body is capped by MaxBytesReader above
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, domain.ErrTooLarge
		}
		return nil, domain.NewValidation(domain.FieldError{Field: field, Reason: "a multipart file is required"})
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()
	f, _, err := r.FormFile(field)
	if err != nil {
		return nil, domain.NewValidation(domain.FieldError{Field: field, Reason: "is required"})
	}
	defer func(f multipart.File) { _ = f.Close() }(f)
	raw, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, domain.NewValidation(domain.FieldError{Field: field, Reason: "cannot be read"})
	}
	if int64(len(raw)) > limit {
		return nil, domain.ErrTooLarge
	}
	return raw, nil
}

// DeleteMyAvatar implements DELETE /me/avatar.
func (a *AuthAPI) DeleteMyAvatar(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	p, err := a.d.Users.DeleteAvatar(r.Context(), actor)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, gen.UserResponse{User: authUserDTO(p)})
}

// GetUserAvatar implements GET /users/{id}/avatar with ETag revalidation.
func (a *AuthAPI) GetUserAvatar(w http.ResponseWriter, r *http.Request, id gen.UserId, params gen.GetUserAvatarParams) {
	if _, ok := actorOrFail(w, r); !ok {
		return
	}
	av, err := a.d.Users.Avatar(r.Context(), id.String())
	if err != nil {
		fail(w, r, err)
		return
	}
	etag := `"` + av.SHA256 + `"`
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, no-cache")
	if params.IfNoneMatch != nil && authETagMatches(*params.IfNoneMatch, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", av.MIME)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(av.Data) // the status is sent; a failed write has no recovery
}

// authETagMatches implements the weak comparison of If-None-Match for a single validator.
func authETagMatches(header, etag string) bool {
	for _, c := range strings.Split(header, ",") {
		c = strings.TrimPrefix(strings.TrimSpace(c), "W/")
		if c == "*" || c == etag {
			return true
		}
	}
	return false
}
