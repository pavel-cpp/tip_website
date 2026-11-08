package http

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// Authenticator verifies an access token (implemented by service.Auth). When the user must
// change a temporary password it returns the actor together with domain.ErrPasswordChangeReq.
type Authenticator interface {
	Authenticate(ctx context.Context, token string) (domain.Actor, error)
}

const apiPrefix = "/api/v1"

// AuthnConfig configures the authentication middleware.
type AuthnConfig struct {
	// Public reports requests that need no token. Nil selects DefaultPublic.
	Public func(r *http.Request) bool
}

// DefaultPublic lists the unauthenticated API routes: login, refresh (cookie based), client
// error reports and the WebSocket upgrade (authenticated by its first frame). Everything outside
// /api/v1 (probes, Swagger, SPA assets) is not API traffic and passes through.
func DefaultPublic(r *http.Request) bool {
	p := r.URL.Path
	if !strings.HasPrefix(p, apiPrefix+"/") {
		return true
	}
	switch p {
	case apiPrefix + "/auth/login", apiPrefix + "/auth/refresh", apiPrefix + "/client-errors":
		return true
	}
	return r.Method == http.MethodGet && strings.HasPrefix(p, apiPrefix+"/projects/") && strings.HasSuffix(p, "/ws")
}

// passwordChangeAllowed lists the endpoints usable while a temporary password must be replaced.
func passwordChangeAllowed(r *http.Request) bool {
	switch r.URL.Path {
	case apiPrefix + "/me", apiPrefix + "/me/password", apiPrefix + "/auth/logout", apiPrefix + "/auth/refresh":
		return true
	}
	return false
}

// bearerToken extracts the token from "Authorization: Bearer <token>".
func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	const prefix = "bearer "
	if len(h) <= len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return "", false
	}
	tok := strings.TrimSpace(h[len(prefix):])
	return tok, tok != ""
}

// Authn returns the authentication middleware: Bearer token -> Authenticate -> WithActor.
// Public routes pass through untouched; failures answer with the standard 401/403/503 envelopes.
func Authn(a Authenticator, cfg AuthnConfig) func(http.Handler) http.Handler {
	public := cfg.Public
	if public == nil {
		public = DefaultPublic
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if public(r) {
				next.ServeHTTP(w, r)
				return
			}
			tok, ok := bearerToken(r)
			if !ok {
				fail(w, r, domain.ErrUnauthenticated)
				return
			}
			actor, err := a.Authenticate(r.Context(), tok)
			switch {
			case errors.Is(err, domain.ErrPasswordChangeReq):
				if !passwordChangeAllowed(r) {
					fail(w, r, err)
					return
				}
			case err != nil:
				fail(w, r, err)
				return
			}
			next.ServeHTTP(w, r.WithContext(WithActor(r.Context(), actor)))
		})
	}
}

// RequirePerm rejects requests whose actor lacks perm with 403. It is an early exit for
// /admin routes; the services check the permission again.
func RequirePerm(perm domain.Permission) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			actor, ok := actorOrFail(w, r)
			if !ok {
				return
			}
			if err := actor.Require(perm); err != nil {
				fail(w, r, err)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// AdminPermGuard applies RequirePerm to the user, role and permission administration routes
// by method and path (the router has not selected a route yet when a global middleware runs).
// Other /admin routes (audit, system) are left to their own streams.
func AdminPermGuard(next http.Handler) http.Handler {
	byPerm := map[domain.Permission]http.Handler{}
	for _, p := range []domain.Permission{domain.PermUserView, domain.PermUserManage, domain.PermRoleManage} {
		byPerm[p] = RequirePerm(p)(next)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p, ok := adminRoutePerm(r.Method, r.URL.Path); ok {
			byPerm[p].ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func adminRoutePerm(method, path string) (domain.Permission, bool) {
	rest, ok := strings.CutPrefix(path, apiPrefix+"/admin/")
	if !ok {
		return "", false
	}
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	switch parts[0] {
	case "permissions", "roles":
		return domain.PermRoleManage, true
	case "users":
		switch {
		case len(parts) == 1 && method == http.MethodGet:
			return domain.PermUserView, true
		case len(parts) == 3 && parts[2] == "roles":
			return domain.PermRoleManage, true
		default:
			return domain.PermUserManage, true
		}
	}
	return "", false
}

// CookieOriginGuard protects the cookie endpoints (login sets, refresh and logout use the
// refresh cookie) against cross-site requests using net/http's CrossOriginProtection, which
// checks Sec-Fetch-Site and Origin on unsafe methods. trustedOrigins mirrors ALLOWED_ORIGINS.
func CookieOriginGuard(trustedOrigins []string) (func(http.Handler) http.Handler, error) {
	cop := http.NewCrossOriginProtection()
	for _, o := range trustedOrigins {
		if err := cop.AddTrustedOrigin(o); err != nil {
			return nil, err
		}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case apiPrefix + "/auth/login", apiPrefix + "/auth/refresh", apiPrefix + "/auth/logout":
				if err := cop.Check(r); err != nil {
					fail(w, r, domain.ErrForbidden)
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}, nil
}
