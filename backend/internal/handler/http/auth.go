package http

// WIRING (for cmd/tipd/main.go and server.go; this file owns the auth, profile, user and role
// operations of gen.ServerInterface):
//
//	api := NewAuthAPI(AuthAPIDeps{Auth: authSvc, Users: usersSvc, Roles: rolesSvc})
//	// Embed it into the struct passed to gen.HandlerWithOptions, ahead of other areas:
//	//   type server struct { *AuthAPI; ...other areas...; gen.Unimplemented }
//	// (embedding gen.Unimplemented one level deeper than the areas lets their methods win).
//
//	guard, _ := CookieOriginGuard(cfg.AllowedOrigins)
//	r.Use(guard)                    // cross-origin protection of login/refresh/logout
//	r.Use(Authn(authSvc, AuthnConfig{})) // Bearer -> service.Auth.Authenticate -> WithActor
//	r.Use(AdminPermGuard)           // early 403 for /admin users, roles and permissions
//
// Authn must run before every handler that calls actorOrFail. Public routes are login, refresh,
// client-errors, the WebSocket upgrade and everything outside /api/v1.
// The refresh token travels in the cookie "tip_rt" (HttpOnly; Secure; SameSite=Strict;
// Path=/api/v1/auth).

import (
	"context"
	"net/http"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

// AuthService is the part of service.Auth used by the handlers.
type AuthService interface {
	Login(ctx context.Context, in service.LoginInput) (service.Session, error)
	Refresh(ctx context.Context, refreshToken string) (service.Session, error)
	Logout(ctx context.Context, actor domain.Actor) error
	ChangePassword(ctx context.Context, actor domain.Actor, in service.ChangePasswordInput) (service.Session, error)
}

// UsersService is the part of service.Users used by the handlers.
type UsersService interface {
	Me(ctx context.Context, actor domain.Actor) (service.Profile, error)
	UpdateProfile(ctx context.Context, actor domain.Actor, in service.ProfileUpdate) (service.Profile, error)
	SetAvatar(ctx context.Context, actor domain.Actor, raw []byte) (service.Profile, error)
	DeleteAvatar(ctx context.Context, actor domain.Actor) (service.Profile, error)
	Avatar(ctx context.Context, userID string) (domain.Avatar, error)
	List(ctx context.Context, actor domain.Actor) ([]service.Profile, error)
	CreateUser(ctx context.Context, actor domain.Actor, in service.CreateUserInput) (service.CreatedUser, error)
	UpdateUser(ctx context.Context, actor domain.Actor, id string, in service.UserUpdate) (service.Profile, error)
	SetRoles(ctx context.Context, actor domain.Actor, id string, roleIDs []string) (service.Profile, error)
	ResetPassword(ctx context.Context, actor domain.Actor, id string) (string, error)
}

// RolesService is the part of service.Roles used by the handlers.
type RolesService interface {
	Catalog(actor domain.Actor) ([]domain.PermissionInfo, error)
	List(ctx context.Context, actor domain.Actor) ([]domain.Role, error)
	Get(ctx context.Context, actor domain.Actor, id string) (service.RoleDetail, error)
	Create(ctx context.Context, actor domain.Actor, in service.RoleCreate) (domain.Role, error)
	Update(ctx context.Context, actor domain.Actor, id string, in service.RoleUpdate) (domain.Role, error)
	Delete(ctx context.Context, actor domain.Actor, id string) error
}

// AuthAPIDeps are the collaborators of AuthAPI.
type AuthAPIDeps struct {
	Auth  AuthService
	Users UsersService
	Roles RolesService
	// InsecureCookies drops the Secure flag of the refresh cookie. It exists for plain-HTTP
	// development over a LAN address, where browsers refuse to store Secure cookies.
	InsecureCookies bool
}

// AuthAPI implements the auth, profile, user-administration and role-administration operations
// of gen.ServerInterface. Methods that belong to other areas are not defined here.
type AuthAPI struct {
	d AuthAPIDeps
}

// NewAuthAPI builds the handler set.
func NewAuthAPI(d AuthAPIDeps) *AuthAPI { return &AuthAPI{d: d} }

const (
	refreshCookieName = "tip_rt"
	refreshCookiePath = apiPrefix + "/auth"
)

func authSetRefreshCookie(w http.ResponseWriter, token string, expires time.Time, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name: refreshCookieName, Value: token, Path: refreshCookiePath, Expires: expires,
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode,
	})
}

func authClearRefreshCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name: refreshCookieName, Value: "", Path: refreshCookiePath, MaxAge: -1, Expires: time.Unix(0, 0),
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode,
	})
}

// authNoStore marks responses carrying tokens or one-time passwords as uncacheable.
func authNoStore(w http.ResponseWriter) { w.Header().Set("Cache-Control", "no-store") }

// authUserDTO converts a profile to the API user.
func authUserDTO(p service.Profile) gen.User {
	u := p.User
	roles := make([]gen.RoleRef, len(u.Roles))
	for i, r := range u.Roles {
		roles[i] = gen.RoleRef{Id: authUUID(r.ID), Name: r.Name}
	}
	perms := make([]gen.PermissionCode, len(p.Permissions))
	for i, c := range p.Permissions {
		perms[i] = gen.PermissionCode(c)
	}
	return gen.User{
		Id: authUUID(u.ID), Login: u.Login, DisplayName: u.DisplayName, Color: u.Color,
		Locale: gen.Locale(u.Locale), Theme: gen.Theme(u.Theme), PasswordTemporary: u.PasswordTemporary,
		AvatarUrl: authAvatarURL(u.ID, p.AvatarSHA), Roles: roles, Permissions: perms,
	}
}

func authAvatarURL(userID, sha string) *string {
	if sha == "" {
		return nil
	}
	v := sha
	if len(v) > 8 {
		v = v[:8]
	}
	u := apiPrefix + "/users/" + userID + "/avatar?v=" + v
	return &u
}

// Login implements POST /auth/login.
func (a *AuthAPI) Login(w http.ResponseWriter, r *http.Request) {
	var body gen.LoginRequest
	if err := decodeJSON(w, r, &body); err != nil {
		fail(w, r, err)
		return
	}
	s, err := a.d.Auth.Login(r.Context(), service.LoginInput{Login: body.Login, Password: body.Password, IP: clientIP(r)})
	if err != nil {
		fail(w, r, err)
		return
	}
	authSetRefreshCookie(w, s.Pair.RefreshToken, s.Pair.RefreshExpiresAt, !a.d.InsecureCookies)
	authNoStore(w)
	writeJSON(w, http.StatusOK, gen.LoginResponse{AccessToken: s.Pair.AccessToken, ExpiresIn: s.ExpiresIn, User: authUserDTO(s.User)})
}

// RefreshToken implements POST /auth/refresh.
func (a *AuthAPI) RefreshToken(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(refreshCookieName)
	if err != nil || c.Value == "" {
		fail(w, r, domain.ErrRefreshInvalid)
		return
	}
	s, err := a.d.Auth.Refresh(r.Context(), c.Value)
	if err != nil {
		if domain.CodeOf(err) == domain.CodeRefreshInvalid {
			authClearRefreshCookie(w, !a.d.InsecureCookies)
		}
		fail(w, r, err)
		return
	}
	authSetRefreshCookie(w, s.Pair.RefreshToken, s.Pair.RefreshExpiresAt, !a.d.InsecureCookies)
	authNoStore(w)
	writeJSON(w, http.StatusOK, gen.TokenResponse{AccessToken: s.Pair.AccessToken, ExpiresIn: s.ExpiresIn})
}

// Logout implements POST /auth/logout.
func (a *AuthAPI) Logout(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	if err := a.d.Auth.Logout(r.Context(), actor); err != nil {
		fail(w, r, err)
		return
	}
	authClearRefreshCookie(w, !a.d.InsecureCookies)
	w.WriteHeader(http.StatusNoContent)
}

// ChangePassword implements POST /me/password.
func (a *AuthAPI) ChangePassword(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	var body gen.ChangePasswordRequest
	if err := decodeJSON(w, r, &body); err != nil {
		fail(w, r, err)
		return
	}
	s, err := a.d.Auth.ChangePassword(r.Context(), actor, service.ChangePasswordInput{Current: body.Current, New: body.New, IP: clientIP(r)})
	if err != nil {
		fail(w, r, err)
		return
	}
	authSetRefreshCookie(w, s.Pair.RefreshToken, s.Pair.RefreshExpiresAt, !a.d.InsecureCookies)
	authNoStore(w)
	writeJSON(w, http.StatusOK, gen.TokenResponse{AccessToken: s.Pair.AccessToken, ExpiresIn: s.ExpiresIn})
}
