package http

import (
	"net/http"

	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

func authAdminUserDTO(p service.Profile) gen.AdminUser {
	return gen.AdminUser{IsActive: p.User.IsActive, LastLoginAt: p.User.LastLoginAt, User: authUserDTO(p)}
}

func authIDs(in []gen.UserId) []string {
	out := make([]string, len(in))
	for i, id := range in {
		out[i] = id.String()
	}
	return out
}

// ListUsers implements GET /admin/users.
func (a *AuthAPI) ListUsers(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	list, err := a.d.Users.List(r.Context(), actor)
	if err != nil {
		fail(w, r, err)
		return
	}
	out := make([]gen.AdminUser, len(list))
	for i, p := range list {
		out[i] = authAdminUserDTO(p)
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateUser implements POST /admin/users.
func (a *AuthAPI) CreateUser(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	var body gen.CreateUserRequest
	if err := decodeJSON(w, r, &body); err != nil {
		fail(w, r, err)
		return
	}
	in := service.CreateUserInput{Login: body.Login, DisplayName: body.DisplayName, IP: clientIP(r)}
	if body.Color != nil {
		in.Color = *body.Color
	}
	if body.RoleIds != nil {
		in.RoleIDs = authIDs(*body.RoleIds)
	}
	created, err := a.d.Users.CreateUser(r.Context(), actor, in)
	if err != nil {
		fail(w, r, err)
		return
	}
	authNoStore(w)
	writeJSON(w, http.StatusCreated, gen.CreateUserResponse{User: authUserDTO(created.Profile), TempPassword: created.TempPassword})
}

// UpdateUser implements PATCH /admin/users/{id}.
func (a *AuthAPI) UpdateUser(w http.ResponseWriter, r *http.Request, id gen.UserId) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	var body gen.UpdateUserRequest
	if err := decodeJSON(w, r, &body); err != nil {
		fail(w, r, err)
		return
	}
	p, err := a.d.Users.UpdateUser(r.Context(), actor, id.String(), service.UserUpdate{DisplayName: body.DisplayName, IsActive: body.IsActive})
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, gen.UserResponse{User: authUserDTO(p)})
}

// SetUserRoles implements PUT /admin/users/{id}/roles.
func (a *AuthAPI) SetUserRoles(w http.ResponseWriter, r *http.Request, id gen.UserId) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	var body gen.SetUserRolesRequest
	if err := decodeJSON(w, r, &body); err != nil {
		fail(w, r, err)
		return
	}
	p, err := a.d.Users.SetRoles(r.Context(), actor, id.String(), authIDs(body.RoleIds))
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, gen.UserResponse{User: authUserDTO(p)})
}

// ResetUserPassword implements POST /admin/users/{id}/reset-password.
func (a *AuthAPI) ResetUserPassword(w http.ResponseWriter, r *http.Request, id gen.UserId) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	pw, err := a.d.Users.ResetPassword(r.Context(), actor, id.String())
	if err != nil {
		fail(w, r, err)
		return
	}
	authNoStore(w)
	writeJSON(w, http.StatusOK, gen.TempPasswordResponse{TempPassword: pw})
}
