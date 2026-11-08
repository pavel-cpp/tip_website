package http

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

const (
	uidA  = "11111111-1111-7111-8111-111111111111"
	uidB  = "22222222-2222-7222-8222-222222222222"
	ridW  = "33333333-3333-7333-8333-333333333333"
	tokOK = "good-token"
)

var fixedProfile = service.Profile{
	User: domain.User{
		ID: uidA, Login: "azam", DisplayName: "Azam", Color: "#6cb4ff", Locale: domain.LocaleRU, Theme: domain.ThemeDark,
		IsActive: true, Roles: []domain.RoleRef{{ID: ridW, Name: "worker"}},
	},
	Permissions: []domain.Permission{domain.PermProjectView},
	AvatarSHA:   "abcdef0123456789",
}

type fakeAuth struct {
	loginIn   service.LoginInput
	changeIn  service.ChangePasswordInput
	refreshIn string
	err       error
	loggedOut bool
}

func (f *fakeAuth) session() service.Session {
	exp := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)
	return service.Session{
		Pair:      domain.TokenPair{AccessToken: "acc", RefreshToken: "ref", RefreshExpiresAt: exp},
		ExpiresIn: 900, User: fixedProfile,
	}
}

func (f *fakeAuth) Login(_ context.Context, in service.LoginInput) (service.Session, error) {
	f.loginIn = in
	return f.session(), f.err
}

func (f *fakeAuth) Refresh(_ context.Context, tok string) (service.Session, error) {
	f.refreshIn = tok
	return f.session(), f.err
}

func (f *fakeAuth) Logout(context.Context, domain.Actor) error {
	f.loggedOut = f.err == nil
	return f.err
}

func (f *fakeAuth) ChangePassword(_ context.Context, _ domain.Actor, in service.ChangePasswordInput) (service.Session, error) {
	f.changeIn = in
	return f.session(), f.err
}

func (f *fakeAuth) Authenticate(_ context.Context, tok string) (domain.Actor, error) {
	switch tok {
	case tokOK:
		return domain.Actor{UserID: uidA, Perms: domain.NewPermissionSet(domain.PermUserView, domain.PermUserManage, domain.PermRoleManage)}, nil
	case "limited":
		return domain.Actor{UserID: uidA, Perms: domain.NewPermissionSet(domain.PermUserView)}, nil
	case "temp":
		return domain.Actor{UserID: uidA}, domain.ErrPasswordChangeReq
	case "expired":
		return domain.Actor{}, domain.ErrTokenExpired
	case "stale":
		return domain.Actor{}, domain.ErrTokenStale
	case "down":
		return domain.Actor{}, domain.ErrAuthUnavailable
	}
	return domain.Actor{}, domain.ErrUnauthenticated
}

type fakeUsers struct {
	err        error
	update     service.ProfileUpdate
	avatarRaw  []byte
	createIn   service.CreateUserInput
	updateIn   service.UserUpdate
	rolesIn    []string
	avatar     domain.Avatar
	avatarErr  error
	resetCalls int
}

func (f *fakeUsers) prof() (service.Profile, error) { return fixedProfile, f.err }

func (f *fakeUsers) Me(context.Context, domain.Actor) (service.Profile, error) { return f.prof() }
func (f *fakeUsers) UpdateProfile(_ context.Context, _ domain.Actor, in service.ProfileUpdate) (service.Profile, error) {
	f.update = in
	return f.prof()
}
func (f *fakeUsers) SetAvatar(_ context.Context, _ domain.Actor, raw []byte) (service.Profile, error) {
	f.avatarRaw = raw
	return f.prof()
}
func (f *fakeUsers) DeleteAvatar(context.Context, domain.Actor) (service.Profile, error) {
	return f.prof()
}
func (f *fakeUsers) Avatar(context.Context, string) (domain.Avatar, error) {
	return f.avatar, f.avatarErr
}
func (f *fakeUsers) List(context.Context, domain.Actor) ([]service.Profile, error) {
	last := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	p := fixedProfile
	p.User.LastLoginAt = &last
	return []service.Profile{p}, f.err
}
func (f *fakeUsers) CreateUser(_ context.Context, _ domain.Actor, in service.CreateUserInput) (service.CreatedUser, error) {
	f.createIn = in
	return service.CreatedUser{Profile: fixedProfile, TempPassword: "TempPass123456789"}, f.err
}
func (f *fakeUsers) UpdateUser(_ context.Context, _ domain.Actor, _ string, in service.UserUpdate) (service.Profile, error) {
	f.updateIn = in
	return f.prof()
}
func (f *fakeUsers) SetRoles(_ context.Context, _ domain.Actor, _ string, ids []string) (service.Profile, error) {
	f.rolesIn = ids
	return f.prof()
}
func (f *fakeUsers) ResetPassword(context.Context, domain.Actor, string) (string, error) {
	f.resetCalls++
	return "NewTemp", f.err
}

type fakeRoles struct {
	err      error
	createIn service.RoleCreate
	updateIn service.RoleUpdate
	deleted  string
}

var fixedRole = domain.Role{ID: ridW, Name: "worker", IsSystem: true, Permissions: []domain.Permission{domain.PermProjectView}, UserCount: 2}

func (f *fakeRoles) Catalog(domain.Actor) ([]domain.PermissionInfo, error) {
	return domain.Catalog(), f.err
}
func (f *fakeRoles) List(context.Context, domain.Actor) ([]domain.Role, error) {
	return []domain.Role{fixedRole}, f.err
}
func (f *fakeRoles) Get(context.Context, domain.Actor, string) (service.RoleDetail, error) {
	return service.RoleDetail{Role: fixedRole, Users: []domain.UserRef{{ID: uidB, DisplayName: "B", Color: "#000000"}}}, f.err
}
func (f *fakeRoles) Create(_ context.Context, _ domain.Actor, in service.RoleCreate) (domain.Role, error) {
	f.createIn = in
	return fixedRole, f.err
}
func (f *fakeRoles) Update(_ context.Context, _ domain.Actor, _ string, in service.RoleUpdate) (domain.Role, error) {
	f.updateIn = in
	return fixedRole, f.err
}
func (f *fakeRoles) Delete(_ context.Context, _ domain.Actor, id string) error {
	f.deleted = id
	return f.err
}

// authServer embeds AuthAPI one level above gen.Unimplemented, as the shared rules require.
type authServer struct {
	*AuthAPI
	unimpl
}

type unimpl struct{ gen.Unimplemented }

type env struct {
	h     http.Handler
	auth  *fakeAuth
	users *fakeUsers
	roles *fakeRoles
}

func newEnv(t *testing.T) *env {
	t.Helper()
	e := &env{auth: &fakeAuth{}, users: &fakeUsers{}, roles: &fakeRoles{}}
	api := NewAuthAPI(AuthAPIDeps{Auth: e.auth, Users: e.users, Roles: e.roles})
	guard, err := CookieOriginGuard([]string{"https://tip.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	r.Use(guard)
	r.Use(Authn(e.auth, AuthnConfig{}))
	r.Use(AdminPermGuard)
	e.h = gen.HandlerWithOptions(authServer{AuthAPI: api}, gen.ChiServerOptions{BaseURL: "/api/v1", BaseRouter: r})
	return e
}

func (e *env) do(method, path, body string, hdr map[string]string) *httptest.ResponseRecorder {
	var rd *strings.Reader
	if body != "" {
		rd = strings.NewReader(body)
	} else {
		rd = strings.NewReader("")
	}
	req := httptest.NewRequest(method, path, rd)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

var bearer = map[string]string{"Authorization": "Bearer " + tokOK}

func errCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var env struct {
		Error struct{ Code string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("not an error envelope: %s", rec.Body.String())
	}
	return env.Error.Code
}

func TestLoginSetsCookieAndBody(t *testing.T) {
	e := newEnv(t)
	rec := e.do("POST", "/api/v1/auth/login", `{"login":"azam","password":"pw"}`, nil)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var resp gen.LoginResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.AccessToken != "acc" || resp.ExpiresIn != 900 || resp.User.Login != "azam" || len(resp.User.Roles) != 1 {
		t.Fatalf("resp = %+v", resp)
	}
	if resp.User.AvatarUrl == nil || *resp.User.AvatarUrl != "/api/v1/users/"+uidA+"/avatar?v=abcdef01" {
		t.Fatalf("avatar url = %v", resp.User.AvatarUrl)
	}
	c := rec.Result().Cookies()
	if len(c) != 1 || c[0].Name != "tip_rt" || c[0].Value != "ref" || !c[0].HttpOnly || !c[0].Secure ||
		c[0].SameSite != http.SameSiteStrictMode || c[0].Path != "/api/v1/auth" {
		t.Fatalf("cookie = %+v", c)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("tokens must not be cached")
	}
	if e.auth.loginIn.Login != "azam" || e.auth.loginIn.IP == "" {
		t.Fatalf("login input = %+v", e.auth.loginIn)
	}
}

func TestLoginErrors(t *testing.T) {
	e := newEnv(t)
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{domain.ErrBadCredentials, 401, "BAD_CREDENTIALS"},
		{domain.NewRateLimited(90 * time.Second), 429, "RATE_LIMITED"},
		{domain.ErrAuthUnavailable, 503, "AUTH_UNAVAILABLE"},
	}
	for _, c := range cases {
		e.auth.err = c.err
		rec := e.do("POST", "/api/v1/auth/login", `{"login":"a","password":"b"}`, nil)
		if rec.Code != c.status || errCode(t, rec) != c.code {
			t.Errorf("%s: %d %s", c.code, rec.Code, rec.Body)
		}
		if len(rec.Result().Cookies()) != 0 {
			t.Errorf("%s: cookie set on failure", c.code)
		}
	}
	e.auth.err = domain.NewRateLimited(90 * time.Second)
	if rec := e.do("POST", "/api/v1/auth/login", `{"login":"a","password":"b"}`, nil); rec.Header().Get("Retry-After") != "90" {
		t.Errorf("Retry-After = %q", rec.Header().Get("Retry-After"))
	}
	if rec := e.do("POST", "/api/v1/auth/login", `{"login":"a"`, nil); rec.Code != 400 {
		t.Errorf("malformed body: %d", rec.Code)
	}
	if rec := e.do("POST", "/api/v1/auth/login", `{"login":"a","password":"b","x":1}`, nil); rec.Code != 400 {
		t.Errorf("unknown field: %d", rec.Code)
	}
}

func TestRefreshUsesCookie(t *testing.T) {
	e := newEnv(t)
	rec := e.do("POST", "/api/v1/auth/refresh", "", nil)
	if rec.Code != 401 || errCode(t, rec) != "REFRESH_INVALID" {
		t.Fatalf("no cookie: %d %s", rec.Code, rec.Body)
	}
	rec = e.do("POST", "/api/v1/auth/refresh", "", map[string]string{"Cookie": "tip_rt=old-refresh"})
	if rec.Code != 200 || e.auth.refreshIn != "old-refresh" {
		t.Fatalf("status %d in=%q", rec.Code, e.auth.refreshIn)
	}
	var tr gen.TokenResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &tr)
	if tr.AccessToken != "acc" || rec.Result().Cookies()[0].Value != "ref" {
		t.Fatalf("resp %+v cookies %v", tr, rec.Result().Cookies())
	}

	e.auth.err = domain.ErrRefreshInvalid
	rec = e.do("POST", "/api/v1/auth/refresh", "", map[string]string{"Cookie": "tip_rt=bad"})
	c := rec.Result().Cookies()
	if rec.Code != 401 || len(c) != 1 || c[0].MaxAge >= 0 {
		t.Fatalf("invalid refresh must clear the cookie: %d %v", rec.Code, c)
	}
	e.auth.err = domain.ErrAuthUnavailable
	rec = e.do("POST", "/api/v1/auth/refresh", "", map[string]string{"Cookie": "tip_rt=x"})
	if rec.Code != 503 || len(rec.Result().Cookies()) != 0 {
		t.Fatalf("503 must keep the cookie: %d", rec.Code)
	}
}

func TestLogout(t *testing.T) {
	e := newEnv(t)
	rec := e.do("POST", "/api/v1/auth/logout", "", bearer)
	c := rec.Result().Cookies()
	if rec.Code != 204 || !e.auth.loggedOut || len(c) != 1 || c[0].MaxAge >= 0 {
		t.Fatalf("status %d cookies %v", rec.Code, c)
	}
	e.auth.err = domain.ErrAuthUnavailable
	if rec := e.do("POST", "/api/v1/auth/logout", "", bearer); rec.Code != 503 {
		t.Fatalf("logout failure: %d", rec.Code)
	}
}

func TestChangePassword(t *testing.T) {
	e := newEnv(t)
	rec := e.do("POST", "/api/v1/me/password", `{"current":"old","new":"newpass123"}`, bearer)
	if rec.Code != 200 || e.auth.changeIn.Current != "old" || e.auth.changeIn.New != "newpass123" {
		t.Fatalf("status %d in=%+v", rec.Code, e.auth.changeIn)
	}
	if c := rec.Result().Cookies(); len(c) != 1 || c[0].Value != "ref" {
		t.Fatalf("cookies = %v", c)
	}
	e.auth.err = domain.NewValidation(domain.FieldError{Field: "current", Reason: "is incorrect"})
	rec = e.do("POST", "/api/v1/me/password", `{"current":"x","new":"newpass123"}`, bearer)
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), `"field":"current"`) {
		t.Fatalf("validation: %d %s", rec.Code, rec.Body)
	}
}

func TestAuthnMiddleware(t *testing.T) {
	e := newEnv(t)
	cases := []struct {
		name   string
		hdr    map[string]string
		status int
		code   string
	}{
		{"no header", nil, 401, "UNAUTHENTICATED"},
		{"wrong scheme", map[string]string{"Authorization": "Basic abc"}, 401, "UNAUTHENTICATED"},
		{"empty bearer", map[string]string{"Authorization": "Bearer "}, 401, "UNAUTHENTICATED"},
		{"invalid", map[string]string{"Authorization": "Bearer nope"}, 401, "UNAUTHENTICATED"},
		{"expired", map[string]string{"Authorization": "Bearer expired"}, 401, "TOKEN_EXPIRED"},
		{"stale", map[string]string{"Authorization": "Bearer stale"}, 401, "TOKEN_STALE"},
		{"redis closed", map[string]string{"Authorization": "Bearer down"}, 503, "AUTH_UNAVAILABLE"},
		{"lowercase scheme", map[string]string{"Authorization": "bearer " + tokOK}, 200, ""},
		{"ok", bearer, 200, ""},
	}
	for _, c := range cases {
		rec := e.do("GET", "/api/v1/me", "", c.hdr)
		if rec.Code != c.status || (c.code != "" && errCode(t, rec) != c.code) {
			t.Errorf("%s: %d %s", c.name, rec.Code, rec.Body)
		}
	}
}

func TestPasswordChangeRequiredGate(t *testing.T) {
	e := newEnv(t)
	temp := map[string]string{"Authorization": "Bearer temp"}
	for _, p := range []struct{ method, path string }{
		{"GET", "/api/v1/me"}, {"PATCH", "/api/v1/me"}, {"POST", "/api/v1/me/password"}, {"POST", "/api/v1/auth/logout"},
	} {
		body := ""
		if p.method != "GET" && p.path != "/api/v1/auth/logout" {
			if p.path == "/api/v1/me" {
				body = `{"displayName":"x"}`
			} else {
				body = `{"current":"a","new":"bbbbbbbb"}`
			}
		}
		if rec := e.do(p.method, p.path, body, temp); rec.Code >= 400 {
			t.Errorf("%s %s must be allowed: %d %s", p.method, p.path, rec.Code, rec.Body)
		}
	}
	for _, p := range []struct{ method, path string }{
		{"GET", "/api/v1/admin/users"}, {"DELETE", "/api/v1/me/avatar"}, {"GET", "/api/v1/users/" + uidA + "/avatar"},
	} {
		rec := e.do(p.method, p.path, "", temp)
		if rec.Code != 403 || errCode(t, rec) != "PASSWORD_CHANGE_REQUIRED" {
			t.Errorf("%s %s: %d %s", p.method, p.path, rec.Code, rec.Body)
		}
	}
}

func TestDefaultPublicRoutes(t *testing.T) {
	for path, want := range map[string]bool{
		"/api/v1/auth/login": true, "/api/v1/auth/refresh": true, "/api/v1/client-errors": true,
		"/healthz": true, "/api/docs": true, "/api/v1/projects/abc/ws": true,
		"/api/v1/me": false, "/api/v1/projects": false, "/api/v1/auth/logout": false, "/api/v1/admin/users": false,
	} {
		r := httptest.NewRequest("GET", path, nil)
		if got := DefaultPublic(r); got != want {
			t.Errorf("%s: public=%v want %v", path, got, want)
		}
	}
	if DefaultPublic(httptest.NewRequest("POST", "/api/v1/projects/abc/ws", nil)) {
		t.Error("only GET upgrades are public")
	}
}

func TestAdminPermGuard(t *testing.T) {
	e := newEnv(t)
	limited := map[string]string{"Authorization": "Bearer limited"} // user.view only
	cases := []struct {
		method, path string
		hdr          map[string]string
		status       int
	}{
		{"GET", "/api/v1/admin/users", limited, 200},
		{"POST", "/api/v1/admin/users", limited, 403},
		{"PATCH", "/api/v1/admin/users/" + uidA, limited, 403},
		{"POST", "/api/v1/admin/users/" + uidA + "/reset-password", limited, 403},
		{"PUT", "/api/v1/admin/users/" + uidA + "/roles", limited, 403},
		{"GET", "/api/v1/admin/roles", limited, 403},
		{"GET", "/api/v1/admin/permissions", limited, 403},
		{"GET", "/api/v1/admin/roles", bearer, 200},
	}
	for _, c := range cases {
		body := ""
		if c.method == "POST" && strings.HasSuffix(c.path, "/users") {
			body = `{"login":"abc","displayName":"A"}`
		}
		if c.method == "PATCH" {
			body = `{"isActive":true}`
		}
		if c.method == "PUT" {
			body = `{"roleIds":["` + ridW + `"]}`
		}
		rec := e.do(c.method, c.path, body, c.hdr)
		if rec.Code != c.status {
			t.Errorf("%s %s: %d (%s)", c.method, c.path, rec.Code, rec.Body)
		}
		if c.status == 403 && errCode(t, rec) != "FORBIDDEN" {
			t.Errorf("%s %s: code %s", c.method, c.path, errCode(t, rec))
		}
	}
	if e.users.resetCalls != 0 {
		t.Error("guard must stop the request before the handler")
	}
}

func TestRequirePerm(t *testing.T) {
	h := RequirePerm(domain.PermAuditView)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	req := httptest.NewRequest("GET", "/x", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("no actor: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req.WithContext(WithActor(req.Context(), domain.Actor{Perms: domain.NewPermissionSet(domain.PermAuditView)})))
	if rec.Code != 200 {
		t.Fatalf("with perm: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req.WithContext(WithActor(req.Context(), domain.Actor{})))
	if rec.Code != 403 {
		t.Fatalf("without perm: %d", rec.Code)
	}
}

func TestCookieOriginGuard(t *testing.T) {
	e := newEnv(t)
	cookie := map[string]string{"Cookie": "tip_rt=r"}
	with := func(extra map[string]string) map[string]string {
		m := map[string]string{"Cookie": "tip_rt=r"}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	_ = cookie
	cases := []struct {
		name   string
		hdr    map[string]string
		status int
	}{
		{"no browser headers (curl)", with(nil), 200},
		{"same origin", with(map[string]string{"Sec-Fetch-Site": "same-origin"}), 200},
		{"cross site", with(map[string]string{"Sec-Fetch-Site": "cross-site"}), 403},
		{"same site other origin", with(map[string]string{"Sec-Fetch-Site": "same-site"}), 403},
		{"foreign Origin", with(map[string]string{"Origin": "https://evil.example"}), 403},
		{"trusted Origin", with(map[string]string{"Origin": "https://tip.example.com"}), 200},
	}
	for _, c := range cases {
		rec := e.do("POST", "/api/v1/auth/refresh", "", c.hdr)
		if rec.Code != c.status {
			t.Errorf("%s: %d %s", c.name, rec.Code, rec.Body)
		}
		if c.status == 403 && errCode(t, rec) != "FORBIDDEN" {
			t.Errorf("%s: envelope %s", c.name, rec.Body)
		}
	}
	// Login is guarded as well; ordinary API routes are not (Bearer protects them).
	if rec := e.do("POST", "/api/v1/auth/login", `{"login":"a","password":"b"}`, map[string]string{"Sec-Fetch-Site": "cross-site"}); rec.Code != 403 {
		t.Errorf("login cross-site: %d", rec.Code)
	}
	if rec := e.do("PATCH", "/api/v1/me", `{"displayName":"x"}`, map[string]string{"Authorization": "Bearer " + tokOK, "Sec-Fetch-Site": "cross-site"}); rec.Code != 200 {
		t.Errorf("bearer route must not be origin-checked: %d", rec.Code)
	}
	if _, err := CookieOriginGuard([]string{"not-an-origin"}); err == nil {
		t.Error("invalid trusted origin accepted")
	}
}

func TestMeEndpoints(t *testing.T) {
	e := newEnv(t)
	rec := e.do("GET", "/api/v1/me", "", bearer)
	var ur gen.UserResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &ur); err != nil || rec.Code != 200 || ur.User.Permissions[0] != "project.view" {
		t.Fatalf("get me: %d %s", rec.Code, rec.Body)
	}
	rec = e.do("PATCH", "/api/v1/me", `{"displayName":"New","color":"#112233","locale":"uz","theme":"light"}`, bearer)
	u := e.users.update
	if rec.Code != 200 || *u.DisplayName != "New" || *u.Color != "#112233" || *u.Locale != "uz" || *u.Theme != "light" {
		t.Fatalf("patch me: %d %+v", rec.Code, u)
	}
	e.users.err = domain.NewValidation(domain.FieldError{Field: "locale", Reason: "bad"})
	if rec := e.do("PATCH", "/api/v1/me", `{"locale":"de"}`, bearer); rec.Code != 400 {
		t.Fatalf("validation: %d", rec.Code)
	}
	e.users.err = nil
	if rec := e.do("DELETE", "/api/v1/me/avatar", "", bearer); rec.Code != 200 {
		t.Fatalf("delete avatar: %d", rec.Code)
	}
}

func multipartBody(t *testing.T, field string, data []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile(field, "a.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fw.Write(data)
	_ = mw.Close()
	return &buf, mw.FormDataContentType()
}

func putAvatar(e *env, body *bytes.Buffer, ct string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("PUT", "/api/v1/me/avatar", body)
	req.Header.Set("Content-Type", ct)
	req.Header.Set("Authorization", "Bearer "+tokOK)
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

func TestPutAvatar(t *testing.T) {
	e := newEnv(t)
	body, ct := multipartBody(t, "file", []byte("PNGDATA"))
	if rec := putAvatar(e, body, ct); rec.Code != 200 || string(e.users.avatarRaw) != "PNGDATA" {
		t.Fatalf("upload: %d %s raw=%q", rec.Code, rec.Body, e.users.avatarRaw)
	}
	body, ct = multipartBody(t, "other", []byte("x"))
	if rec := putAvatar(e, body, ct); rec.Code != 400 {
		t.Errorf("missing file field: %d", rec.Code)
	}
	body, ct = multipartBody(t, "file", make([]byte, service.MaxAvatarUpload+1))
	if rec := putAvatar(e, body, ct); rec.Code != 413 {
		t.Errorf("too large: %d", rec.Code)
	}
	body, ct = multipartBody(t, "file", make([]byte, service.MaxAvatarUpload+authMultipartOverhead+10))
	if rec := putAvatar(e, body, ct); rec.Code != 413 {
		t.Errorf("way too large: %d", rec.Code)
	}
	if rec := putAvatar(e, bytes.NewBufferString("{}"), "application/json"); rec.Code != 415 {
		t.Errorf("not multipart: %d", rec.Code)
	}
	if rec := putAvatar(e, bytes.NewBufferString("garbage"), "multipart/form-data; boundary=zzz"); rec.Code != 400 {
		t.Errorf("broken multipart: %d", rec.Code)
	}
	e.users.err = domain.ErrImageInvalid
	body, ct = multipartBody(t, "file", []byte("x"))
	if rec := putAvatar(e, body, ct); rec.Code != 422 {
		t.Errorf("invalid image: %d", rec.Code)
	}
}

func TestGetUserAvatarETag(t *testing.T) {
	e := newEnv(t)
	e.users.avatar = domain.Avatar{MIME: "image/jpeg", Data: []byte("JPEG"), SHA256: "abc"}
	path := "/api/v1/users/" + uidA + "/avatar"
	rec := e.do("GET", path, "", bearer)
	if rec.Code != 200 || rec.Header().Get("ETag") != `"abc"` || rec.Header().Get("Content-Type") != "image/jpeg" || rec.Body.String() != "JPEG" {
		t.Fatalf("get: %d %v", rec.Code, rec.Header())
	}
	for _, inm := range []string{`"abc"`, `W/"abc"`, `"zzz", "abc"`, `*`} {
		h := map[string]string{"Authorization": "Bearer " + tokOK, "If-None-Match": inm}
		if rec := e.do("GET", path, "", h); rec.Code != 304 || rec.Body.Len() != 0 {
			t.Errorf("If-None-Match %s: %d", inm, rec.Code)
		}
	}
	h := map[string]string{"Authorization": "Bearer " + tokOK, "If-None-Match": `"old"`}
	if rec := e.do("GET", path, "", h); rec.Code != 200 {
		t.Errorf("stale etag: %d", rec.Code)
	}
	e.users.avatarErr = domain.ErrNotFound
	if rec := e.do("GET", path, "", bearer); rec.Code != 404 {
		t.Errorf("no avatar: %d", rec.Code)
	}
	if rec := e.do("GET", path, "", nil); rec.Code != 401 {
		t.Errorf("anonymous: %d", rec.Code)
	}
}

func TestAdminUsers(t *testing.T) {
	e := newEnv(t)
	rec := e.do("GET", "/api/v1/admin/users", "", bearer)
	var list []gen.AdminUser
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || len(list) != 1 || !list[0].IsActive || list[0].LastLoginAt == nil {
		t.Fatalf("list: %d %s", rec.Code, rec.Body)
	}

	rec = e.do("POST", "/api/v1/admin/users", `{"login":"new.user","displayName":"New","color":"#010203","roleIds":["`+ridW+`"]}`, bearer)
	var cr gen.CreateUserResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &cr); err != nil || rec.Code != 201 || cr.TempPassword != "TempPass123456789" {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	in := e.users.createIn
	if in.Login != "new.user" || in.Color != "#010203" || len(in.RoleIDs) != 1 || in.RoleIDs[0] != ridW {
		t.Fatalf("create input = %+v", in)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Error("temporary password must not be cached")
	}
	e.do("POST", "/api/v1/admin/users", `{"login":"abc","displayName":"A"}`, bearer)
	if e.users.createIn.RoleIDs != nil {
		t.Errorf("omitted roleIds must stay nil (default role), got %v", e.users.createIn.RoleIDs)
	}

	rec = e.do("PATCH", "/api/v1/admin/users/"+uidB, `{"isActive":false,"displayName":"Z"}`, bearer)
	if rec.Code != 200 || e.users.updateIn.IsActive == nil || *e.users.updateIn.IsActive || *e.users.updateIn.DisplayName != "Z" {
		t.Fatalf("patch: %d %+v", rec.Code, e.users.updateIn)
	}
	rec = e.do("PUT", "/api/v1/admin/users/"+uidB+"/roles", `{"roleIds":["`+ridW+`"]}`, bearer)
	if rec.Code != 200 || len(e.users.rolesIn) != 1 {
		t.Fatalf("roles: %d", rec.Code)
	}
	rec = e.do("POST", "/api/v1/admin/users/"+uidB+"/reset-password", "", bearer)
	var tp gen.TempPasswordResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &tp); err != nil || rec.Code != 200 || tp.TempPassword != "NewTemp" || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("reset: %d %s", rec.Code, rec.Body)
	}

	e.users.err = domain.ErrLastAdmin
	if rec := e.do("PATCH", "/api/v1/admin/users/"+uidB, `{"isActive":false}`, bearer); rec.Code != 409 || errCode(t, rec) != "LAST_ADMIN" {
		t.Fatalf("last admin: %d %s", rec.Code, rec.Body)
	}
	if rec := e.do("PATCH", "/api/v1/admin/users/not-a-uuid", `{"isActive":false}`, bearer); rec.Code != 400 {
		t.Fatalf("bad id: %d", rec.Code)
	}
}

func TestAdminRoles(t *testing.T) {
	e := newEnv(t)
	rec := e.do("GET", "/api/v1/admin/permissions", "", bearer)
	var perms []gen.Permission
	if err := json.Unmarshal(rec.Body.Bytes(), &perms); err != nil || len(perms) != len(domain.AllPermissions()) || perms[0].Group != "Projects" {
		t.Fatalf("permissions: %d %s", rec.Code, rec.Body)
	}
	rec = e.do("GET", "/api/v1/admin/roles", "", bearer)
	var roles []gen.Role
	if err := json.Unmarshal(rec.Body.Bytes(), &roles); err != nil || len(roles) != 1 || roles[0].UserCount != 2 || !roles[0].IsSystem {
		t.Fatalf("list: %d %s", rec.Code, rec.Body)
	}
	rec = e.do("POST", "/api/v1/admin/roles", `{"name":"Senior","description":"d","permissions":["project.view"]}`, bearer)
	if rec.Code != 201 || e.roles.createIn.Name != "Senior" || e.roles.createIn.Permissions[0] != "project.view" {
		t.Fatalf("create: %d %+v", rec.Code, e.roles.createIn)
	}
	rec = e.do("GET", "/api/v1/admin/roles/"+ridW, "", bearer)
	var det gen.RoleDetailResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &det); err != nil || len(det.Users) != 1 || det.Role.Name != "worker" {
		t.Fatalf("get: %d %s", rec.Code, rec.Body)
	}
	rec = e.do("PATCH", "/api/v1/admin/roles/"+ridW, `{"description":"new","permissions":["project.view","participant.view"]}`, bearer)
	up := e.roles.updateIn
	if rec.Code != 200 || *up.Description != "new" || up.Name != nil || len(*up.Permissions) != 2 {
		t.Fatalf("patch: %d %+v", rec.Code, up)
	}
	e.do("PATCH", "/api/v1/admin/roles/"+ridW, `{"name":"n"}`, bearer)
	if e.roles.updateIn.Permissions != nil {
		t.Error("omitted permissions must stay nil")
	}
	if rec := e.do("DELETE", "/api/v1/admin/roles/"+ridW, "", bearer); rec.Code != 204 || e.roles.deleted != ridW {
		t.Fatalf("delete: %d", rec.Code)
	}
	for err, want := range map[error]string{
		domain.NewRoleInUse([]string{uidA}): "ROLE_IN_USE",
		domain.ErrRoleSystem:                "ROLE_SYSTEM",
		domain.ErrNotFound:                  "NOT_FOUND",
		errors.New("sql: boom"):             "INTERNAL",
	} {
		e.roles.err = err
		rec := e.do("DELETE", "/api/v1/admin/roles/"+ridW, "", bearer)
		if errCode(t, rec) != want {
			t.Errorf("%s: %d %s", want, rec.Code, rec.Body)
		}
		if want == "INTERNAL" && strings.Contains(rec.Body.String(), "boom") {
			t.Error("internal error text leaked")
		}
		if want == "ROLE_IN_USE" && !strings.Contains(rec.Body.String(), uidA) {
			t.Error("ROLE_IN_USE must list the users")
		}
	}
}
