package http

import (
	"net/http"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

func authRoleDTO(r domain.Role) gen.Role {
	perms := make([]gen.PermissionCode, len(r.Permissions))
	for i, p := range r.Permissions {
		perms[i] = gen.PermissionCode(p)
	}
	return gen.Role{
		Id: authUUID(r.ID), Name: r.Name, Description: r.Description, IsSystem: r.IsSystem,
		Permissions: perms, UserCount: r.UserCount,
	}
}

func authPermStrings[T ~string](in []T) []string {
	out := make([]string, len(in))
	for i, p := range in {
		out[i] = string(p)
	}
	return out
}

// ListPermissions implements GET /admin/permissions.
func (a *AuthAPI) ListPermissions(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	cat, err := a.d.Roles.Catalog(actor)
	if err != nil {
		fail(w, r, err)
		return
	}
	out := make([]gen.Permission, len(cat))
	for i, p := range cat {
		out[i] = gen.Permission{Code: gen.PermissionCode(p.Code), Group: p.Group, Description: p.Description}
	}
	writeJSON(w, http.StatusOK, out)
}

// ListRoles implements GET /admin/roles.
func (a *AuthAPI) ListRoles(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	roles, err := a.d.Roles.List(r.Context(), actor)
	if err != nil {
		fail(w, r, err)
		return
	}
	out := make([]gen.Role, len(roles))
	for i, ro := range roles {
		out[i] = authRoleDTO(ro)
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateRole implements POST /admin/roles.
func (a *AuthAPI) CreateRole(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	var body gen.CreateRoleRequest
	if err := decodeJSON(w, r, &body); err != nil {
		fail(w, r, err)
		return
	}
	role, err := a.d.Roles.Create(r.Context(), actor, service.RoleCreate{
		Name: body.Name, Description: body.Description, Permissions: authPermStrings(body.Permissions),
	})
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, gen.RoleResponse{Role: authRoleDTO(role)})
}

// GetRole implements GET /admin/roles/{id}.
func (a *AuthAPI) GetRole(w http.ResponseWriter, r *http.Request, id gen.RoleId) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	d, err := a.d.Roles.Get(r.Context(), actor, id.String())
	if err != nil {
		fail(w, r, err)
		return
	}
	users := make([]gen.UserRef, len(d.Users))
	for i, u := range d.Users {
		users[i] = gen.UserRef{Id: authUUID(u.ID), DisplayName: u.DisplayName, Color: u.Color, AvatarUrl: authAvatarURL(u.ID, u.AvatarSHA)}
	}
	writeJSON(w, http.StatusOK, gen.RoleDetailResponse{Role: authRoleDTO(d.Role), Users: users})
}

// UpdateRole implements PATCH /admin/roles/{id}.
func (a *AuthAPI) UpdateRole(w http.ResponseWriter, r *http.Request, id gen.RoleId) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	var body gen.UpdateRoleRequest
	if err := decodeJSON(w, r, &body); err != nil {
		fail(w, r, err)
		return
	}
	in := service.RoleUpdate{Name: body.Name, Description: body.Description}
	if body.Permissions != nil {
		p := authPermStrings(*body.Permissions)
		in.Permissions = &p
	}
	role, err := a.d.Roles.Update(r.Context(), actor, id.String(), in)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, gen.RoleResponse{Role: authRoleDTO(role)})
}

// DeleteRole implements DELETE /admin/roles/{id}.
func (a *AuthAPI) DeleteRole(w http.ResponseWriter, r *http.Request, id gen.RoleId) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	if err := a.d.Roles.Delete(r.Context(), actor, id.String()); err != nil {
		fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
