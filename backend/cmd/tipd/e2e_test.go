package main

// End-to-end test: the real composition root (newApp) behind an httptest server, backed by
// throwaway PostgreSQL and Redis containers. It walks one realistic session through the REST
// API and the WebSocket. The test is skipped when Docker is not available.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"
	"github.com/testcontainers/testcontainers-go"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
	"github.com/xuri/excelize/v2"

	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/config"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/db"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/dbtest"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/metrics"
)

const (
	adminLogin    = "boss"
	adminPassword = "boss-password-1"
	workerNewPass = "worker-new-pass"
	replayWindow  = time.Second
)

var (
	redisOnce sync.Once
	redisURL  string
	redisErr  error
)

// startRedis returns the URL of a throwaway Redis (REDIS_TEST_URL or a shared container).
func startRedis(t *testing.T) string {
	t.Helper()
	testcontainers.SkipIfProviderIsNotHealthy(t)
	redisOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		c, err := tcredis.Run(ctx, "redis:7-alpine")
		if err != nil {
			redisErr = err
			return
		}
		redisURL, redisErr = c.ConnectionString(ctx)
	})
	if redisErr != nil {
		t.Skipf("redis test container unavailable: %v", redisErr)
	}
	return redisURL
}

// freshDatabase creates an empty database so the bootstrap administrator is really created.
func freshDatabase(t *testing.T, ctx context.Context) string {
	t.Helper()
	dsn := dbtest.DSN(t)
	admin, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close() }()
	name := fmt.Sprintf("e2e_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	return u.String()
}

// startServer builds the application exactly as `tipd serve` does and serves its router.
func startServer(t *testing.T) (*httptest.Server, *app) {
	t.Helper()
	redis := startRedis(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	env := map[string]string{
		"DATABASE_URL":             freshDatabase(t, ctx),
		"REDIS_URL":                redis,
		"DATA_DIR":                 t.TempDir(),
		"JWT_ACCESS_SECRET":        "e2e-access-secret-0123456789abcdef0123",
		"JWT_REFRESH_SECRET":       "e2e-refresh-secret-fedcba9876543210fedc",
		"PASSWORD_PEPPER":          "e2e-password-pepper-0123456789abcdef01",
		"BOOTSTRAP_ADMIN_LOGIN":    adminLogin,
		"BOOTSTRAP_ADMIN_PASSWORD": adminPassword,
		"FORCE_PASSWORD_CHANGE":    "true",
		"SWAGGER_ENABLED":          "false",
		"LOKI_URL":                 "off",
		"MIN_FREE_DISK_MB":         "1",
	}
	cfg, err := config.Load(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	a, err := newApp(ctx, cfg, zerolog.Nop(), metrics.New("e2e", "e2e"), withReplayWindow(replayWindow))
	if err != nil {
		t.Fatalf("newApp: %v", err)
	}
	a.Start(ctx)
	srv := httptest.NewServer(a.router)
	t.Cleanup(func() {
		sctx, scancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer scancel()
		_ = a.ws.Shutdown(sctx)
		srv.Close()
		a.Stop()
		a.Close()
	})
	return srv, a
}

// --- HTTP helpers -----------------------------------------------------------------------

type client struct {
	t    *testing.T
	base string
}

type reply struct {
	status int
	header http.Header
	body   []byte
}

// do sends a request; body is JSON-encoded unless it is already a reader. Cookies are passed
// by hand because the refresh cookie is Secure and the test server speaks plain HTTP.
func (c *client) do(method, path, token, refresh string, body any) reply {
	c.t.Helper()
	var rd io.Reader
	contentType := ""
	switch b := body.(type) {
	case nil:
	case *bytes.Buffer:
		rd = b
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			c.t.Fatal(err)
		}
		rd, contentType = bytes.NewReader(raw), "application/json"
	}
	req, err := http.NewRequestWithContext(context.Background(), method, c.base+path, rd)
	if err != nil {
		c.t.Fatal(err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if refresh != "" {
		req.AddCookie(&http.Cookie{Name: refreshCookie, Value: refresh})
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		c.t.Fatal(err)
	}
	return reply{status: resp.StatusCode, header: resp.Header, body: raw}
}

const refreshCookie = "tip_rt"

func (r reply) refreshToken() string {
	for _, c := range (&http.Response{Header: r.header}).Cookies() {
		if c.Name == refreshCookie {
			return c.Value
		}
	}
	return ""
}

// expect fails the test unless the status matches, and returns the reply for chaining.
func (r reply) expect(t *testing.T, status int) reply {
	t.Helper()
	if r.status != status {
		t.Fatalf("status = %d, want %d; body: %s", r.status, status, r.body)
	}
	return r
}

// errCode fails unless the reply has the status and returns the error code of the envelope.
func (r reply) errCode(t *testing.T, status int) string {
	t.Helper()
	r.expect(t, status)
	var e gen.Error
	if err := json.Unmarshal(r.body, &e); err != nil {
		t.Fatalf("not an error envelope: %s", r.body)
	}
	return string(e.Error.Code)
}

func decode[T any](t *testing.T, r reply) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(r.body, &v); err != nil {
		t.Fatalf("decode %T: %v; body: %s", v, err, r.body)
	}
	return v
}

// session is one logged-in user: the access token and the current refresh cookie value.
type session struct {
	access, refresh string
	user            gen.User
}

func (c *client) login(login, password string) (session, reply) {
	c.t.Helper()
	r := c.do("POST", "/api/v1/auth/login", "", "", gen.LoginRequest{Login: login, Password: password})
	if r.status != http.StatusOK {
		return session{}, r
	}
	lr := decode[gen.LoginResponse](c.t, r)
	return session{access: lr.AccessToken, refresh: r.refreshToken(), user: lr.User}, r
}

func (c *client) mustLogin(login, password string) session {
	c.t.Helper()
	s, r := c.login(login, password)
	r.expect(c.t, 200)
	return s
}

func (c *client) refresh(refresh string) (session, reply) {
	c.t.Helper()
	r := c.do("POST", "/api/v1/auth/refresh", "", refresh, nil)
	if r.status != http.StatusOK {
		return session{}, r
	}
	return session{access: decode[gen.TokenResponse](c.t, r).AccessToken, refresh: r.refreshToken()}, r
}

func pngImage(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 120, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func multipartFile(t *testing.T, name string, data []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf, mw.FormDataContentType()
}

// --- WebSocket helpers ------------------------------------------------------------------

type wsClient struct {
	t    *testing.T
	conn *websocket.Conn
}

// dialWS connects to the project room and authenticates with the first frame.
func dialWS(t *testing.T, srv *httptest.Server, projectID, token string) (*wsClient, map[string]any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/projects/"+projectID+"/ws", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	c := &wsClient{t: t, conn: conn}
	c.send(map[string]any{"t": "auth", "token": token})
	return c, c.await("hello")
}

func (c *wsClient) send(frame map[string]any) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	raw, _ := json.Marshal(frame)
	if err := c.conn.Write(ctx, websocket.MessageText, raw); err != nil {
		c.t.Fatalf("ws write: %v", err)
	}
}

// await reads frames until one of type t arrives (other frames are skipped).
func (c *wsClient) await(t string) map[string]any {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, raw, err := c.conn.Read(ctx)
		if err != nil {
			c.t.Fatalf("waiting for %q: %v", t, err)
		}
		var f map[string]any
		if err := json.Unmarshal(raw, &f); err != nil {
			c.t.Fatalf("bad frame %s", raw)
		}
		if f["t"] == t {
			return f
		}
	}
}

// --- the scenario -----------------------------------------------------------------------

func TestEndToEnd(t *testing.T) {
	srv, a := startServer(t)
	c := &client{t: t, base: srv.URL}

	var admin, worker session
	var roleID, userID, projectID, firstRow string

	t.Run("probes and bootstrap admin", func(t *testing.T) {
		c.do("GET", "/healthz", "", "", nil).expect(t, 200)
		for _, p := range []string{"/readyz", "/api/v1/readyz"} {
			ready := decode[gen.ReadinessResponse](t, c.do("GET", p, "", "", nil).expect(t, 200))
			if ready.Status != "ok" || ready.Checks.Postgres != "ok" || ready.Checks.Redis != "ok" || ready.Checks.DataDir != "ok" {
				t.Fatalf("%s: %+v", p, ready)
			}
		}
		c.do("GET", "/api/v1/projects", "", "", nil).errCode(t, 401)
		if code := c.do("POST", "/api/v1/auth/login", "", "", gen.LoginRequest{Login: adminLogin, Password: "wrong-password"}).errCode(t, 401); code != "BAD_CREDENTIALS" {
			t.Fatalf("code %s", code)
		}
		admin = c.mustLogin(adminLogin, adminPassword)
		if admin.user.PasswordTemporary || len(admin.user.Roles) != 1 || admin.user.Roles[0].Name != "admin" {
			t.Fatalf("admin user: %+v", admin.user)
		}
		perms := decode[[]gen.Permission](t, c.do("GET", "/api/v1/admin/permissions", admin.access, "", nil).expect(t, 200))
		for _, p := range perms {
			if p.Code == "participant.edit" && len(p.Requires) == 0 {
				t.Fatalf("participant.edit must list its requirements: %+v", p)
			}
		}
	})

	t.Run("admin creates a role and a worker", func(t *testing.T) {
		role := decode[gen.RoleResponse](t, c.do("POST", "/api/v1/admin/roles", admin.access, "", gen.CreateRoleRequest{
			Name: "operator", Description: "edits participants",
			Permissions: []gen.PermissionCode{"project.view", "participant.edit"},
		}).expect(t, 201)).Role
		roleID = role.Id.String()
		created := decode[gen.CreateUserResponse](t, c.do("POST", "/api/v1/admin/users", admin.access, "", gen.CreateUserRequest{
			Login: "worker1", DisplayName: "Worker One", RoleIds: &[]gen.UserId{role.Id},
		}).expect(t, 201))
		userID = created.User.Id.String()

		s, _ := c.login("worker1", created.TempPassword)
		if !s.user.PasswordTemporary {
			t.Fatalf("a fresh account must have a temporary password: %+v", s.user)
		}
		// With FORCE_PASSWORD_CHANGE only /me, /me/password and the token endpoints work.
		if code := c.do("GET", "/api/v1/projects", s.access, "", nil).errCode(t, 403); code != "PASSWORD_CHANGE_REQUIRED" {
			t.Fatalf("code %s", code)
		}
		changed := c.do("POST", "/api/v1/me/password", s.access, s.refresh, gen.ChangePasswordRequest{Current: created.TempPassword, New: workerNewPass}).expect(t, 200)
		worker = session{access: decode[gen.TokenResponse](t, changed).AccessToken, refresh: changed.refreshToken()}
		c.do("GET", "/api/v1/projects", worker.access, "", nil).expect(t, 200)
		if _, r := c.login("worker1", created.TempPassword); r.status != 401 {
			t.Fatalf("the temporary password must stop working, got %d", r.status)
		}
	})

	t.Run("refresh rotation", func(t *testing.T) {
		first, _ := c.refresh(worker.refresh)
		if first.refresh == "" || first.refresh == worker.refresh {
			t.Fatal("refresh must rotate the cookie")
		}
		// A repeat of the same exchange inside the window is idempotent (a second tab, a retry).
		if again, r := c.refresh(worker.refresh); again.access == "" {
			t.Fatalf("replay inside the window failed: %d %s", r.status, r.body)
		}
		time.Sleep(replayWindow + 300*time.Millisecond)
		_, r := c.refresh(worker.refresh)
		if code := r.errCode(t, 401); code != "REFRESH_INVALID" {
			t.Fatalf("code %s", code)
		}
		// Reuse after the window is treated as theft: the whole chain is closed.
		if _, r := c.refresh(first.refresh); r.status != 401 {
			t.Fatalf("the rotated refresh must be dead after reuse detection, got %d", r.status)
		}
		worker = c.mustLogin("worker1", workerNewPass)
	})

	t.Run("admin prepares a project", func(t *testing.T) {
		p := decode[gen.ProjectResponse](t, c.do("POST", "/api/v1/projects", admin.access, "", gen.CreateProjectRequest{Title: "Autumn Cup"}).expect(t, 201)).Project
		projectID = p.Id.String()

		body, ct := multipartFile(t, "ticket.png", pngImage(t, 1200, 600))
		req, _ := http.NewRequestWithContext(context.Background(), "PUT", srv.URL+"/api/v1/projects/"+projectID+"/image", body)
		req.Header.Set("Authorization", "Bearer "+admin.access)
		req.Header.Set("Content-Type", ct)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		up := reply{status: resp.StatusCode, header: resp.Header, body: raw}.expect(t, 200)
		img := decode[gen.ProjectResponse](t, up).Project
		if img.Image == nil || img.Image.W != 1200 || !strings.Contains(img.Image.ThumbUrl, "size=thumb") {
			t.Fatalf("image: %+v", img.Image)
		}
		thumb := c.do("GET", img.Image.ThumbUrl, admin.access, "", nil).expect(t, 200)
		cfg, format, err := image.DecodeConfig(bytes.NewReader(thumb.body))
		if err != nil || format != "jpeg" || cfg.Width != 480 || cfg.Height != 240 {
			t.Fatalf("thumbnail: %v %s %+v", err, format, cfg)
		}
		if !strings.HasSuffix(thumb.header.Get("ETag"), `-thumb"`) {
			t.Fatalf("thumb ETag %q", thumb.header.Get("ETag"))
		}
		orig := c.do("GET", img.Image.Url, admin.access, "", nil).expect(t, 200)
		if orig.header.Get("Content-Type") != "image/png" || len(orig.body) <= len(thumb.body) {
			t.Fatalf("original: %s, %d bytes vs thumb %d", orig.header.Get("Content-Type"), len(orig.body), len(thumb.body))
		}

		name := img.Placeholders.Name
		name.Size, name.X, name.Y = 48, 300, 200
		patched := c.do("PATCH", "/api/v1/projects/"+projectID, admin.access, "", gen.UpdateProjectRequest{
			Version: img.Version, Placeholders: &gen.PlaceholdersPatch{Name: &name},
		}).expect(t, 200)
		after := decode[gen.ProjectResponse](t, patched).Project
		if after.Placeholders.Name.Size != 48 || after.Version != img.Version+1 {
			t.Fatalf("patched project: %+v", after)
		}
		if code := c.do("PATCH", "/api/v1/projects/"+projectID, admin.access, "", gen.UpdateProjectRequest{Version: img.Version, Placeholders: &gen.PlaceholdersPatch{Name: &name}}).errCode(t, 409); code != "VERSION_CONFLICT" {
			t.Fatalf("stale project edit: %s", code)
		}
	})

	t.Run("participants, conflicts and the permission matrix", func(t *testing.T) {
		rows := decode[gen.ParticipantItems](t, c.do("POST", "/api/v1/projects/"+projectID+"/participants", admin.access, "", map[string]any{
			"items": []map[string]string{{"name": "Aziza Karimova", "phone": "+998901234567"}, {"name": "Bobur Aliyev", "phone": "+998907654321"}},
		}).expect(t, 201)).Items
		if len(rows) != 2 {
			t.Fatalf("rows: %+v", rows)
		}
		firstRow = rows[0].Id.String()

		// Worker: reading and editing work, everything else is forbidden.
		cards := decode[[]gen.ProjectCard](t, c.do("GET", "/api/v1/projects", worker.access, "", nil).expect(t, 200))
		if len(cards) != 1 || cards[0].Image == nil || cards[0].Image.ThumbUrl == "" {
			t.Fatalf("worker project list: %+v", cards)
		}
		c.do("GET", "/api/v1/projects/"+projectID+"/participants", worker.access, "", nil).expect(t, 200)
		edit := c.do("PATCH", "/api/v1/participants/"+firstRow, worker.access, "", gen.UpdateParticipantRequest{Version: rows[0].Version, Name: ptr("Aziza K.")}).expect(t, 200)
		if got := decode[gen.ParticipantResponse](t, edit).Item; got.Name != "Aziza K." || got.Version != rows[0].Version+1 {
			t.Fatalf("edited row: %+v", got)
		}
		if code := c.do("PATCH", "/api/v1/participants/"+firstRow, worker.access, "", gen.UpdateParticipantRequest{Version: rows[0].Version, Name: ptr("late")}).errCode(t, 409); code != "VERSION_CONFLICT" {
			t.Fatalf("stale row edit: %s", code)
		}
		forbidden := []struct{ method, path string }{
			{"POST", "/api/v1/projects"},
			{"GET", "/api/v1/admin/users"},
			{"GET", "/api/v1/admin/system"},
			{"GET", "/api/v1/admin/audit"},
			{"GET", "/api/v1/projects/" + projectID + "/export.xlsx"},
		}
		for _, f := range forbidden {
			if code := c.do(f.method, f.path, worker.access, "", map[string]string{"title": "x"}).errCode(t, 403); code != "FORBIDDEN" {
				t.Errorf("%s %s: code %s", f.method, f.path, code)
			}
		}

		// A role change makes issued tokens stale until the next refresh.
		c.do("PATCH", "/api/v1/admin/roles/"+roleID, admin.access, "", map[string]any{
			"name": "operator", "description": "edits and exports",
			"permissions": []string{"project.view", "participant.edit", "participant.export"},
		}).expect(t, 200)
		if code := c.do("GET", "/api/v1/projects", worker.access, "", nil).errCode(t, 401); code != "TOKEN_STALE" {
			t.Fatalf("code %s", code)
		}
		// The permission epoch is global: the admin's token is stale as well.
		for _, s := range []*session{&worker, &admin} {
			renewed, r := c.refresh(s.refresh)
			r.expect(t, 200)
			s.access, s.refresh = renewed.access, renewed.refresh
		}
		xlsx := c.do("GET", "/api/v1/projects/"+projectID+"/export.xlsx", worker.access, "", nil).expect(t, 200)
		f, err := excelize.OpenReader(bytes.NewReader(xlsx.body))
		if err != nil {
			t.Fatalf("export is not an XLSX file: %v", err)
		}
		sheet, err := f.GetRows(f.GetSheetName(0))
		if err != nil || len(sheet) < 3 || !strings.Contains(strings.Join(sheet[1], "|"), "Aziza K.") {
			t.Fatalf("exported rows: %v %v", sheet, err)
		}
		if got := decode[gen.AuditPage](t, c.do("GET", "/api/v1/admin/audit", admin.access, "", nil).expect(t, 200)); len(got.Items) == 0 {
			t.Fatal("the audit log must contain the actions above")
		}
		sys := decode[gen.SystemStatus](t, c.do("GET", "/api/v1/admin/system", admin.access, "", nil).expect(t, 200))
		if sys.Uploads.SizeBytes <= 0 || len(sys.Checks) == 0 {
			t.Fatalf("system status: %+v", sys)
		}
	})

	t.Run("deleting a project keeps its audit trail", func(t *testing.T) {
		p := decode[gen.ProjectResponse](t, c.do("POST", "/api/v1/projects", admin.access, "", gen.CreateProjectRequest{Title: "Short lived"}).expect(t, 201)).Project
		id := p.Id.String()
		c.do("POST", "/api/v1/projects/"+id+"/participants", admin.access, "", map[string]any{
			"items": []map[string]string{{"name": "Temp Person", "phone": "+998900000000"}},
		}).expect(t, 201)
		c.do("DELETE", "/api/v1/projects/"+id, admin.access, "", nil).expect(t, 204)
		if code := c.do("GET", "/api/v1/projects/"+id, admin.access, "", nil).errCode(t, 404); code != "NOT_FOUND" {
			t.Fatalf("deleted project lookup: %s", code)
		}
		page := decode[gen.AuditPage](t, c.do("GET", "/api/v1/admin/audit", admin.access, "", nil).expect(t, 200))
		found := false
		for _, it := range page.Items {
			if it.Action == "project.delete" {
				found = true
			}
		}
		if !found {
			t.Fatal("the audit log must record the deletion")
		}
	})

	t.Run("logout revokes the access token", func(t *testing.T) {
		c.do("POST", "/api/v1/auth/logout", worker.access, worker.refresh, nil).expect(t, 204)
		if code := c.do("GET", "/api/v1/projects", worker.access, "", nil).errCode(t, 401); code != "UNAUTHENTICATED" {
			t.Fatalf("code %s", code)
		}
		if _, r := c.refresh(worker.refresh); r.status != 401 {
			t.Fatalf("refresh after logout: %d", r.status)
		}
	})

	t.Run("websocket presence and lock conflict", func(t *testing.T) {
		worker = c.mustLogin("worker1", workerNewPass)
		adminWS, hello := dialWS(t, srv, projectID, admin.access)
		if hello["you"] != admin.user.Id.String() {
			t.Fatalf("hello: %v", hello)
		}
		workerWS, _ := dialWS(t, srv, projectID, worker.access)
		presence := adminWS.await("presence")
		if peers, _ := presence["peers"].([]any); len(peers) != 2 {
			t.Fatalf("presence: %v", presence)
		}

		adminWS.send(map[string]any{"t": "lock.acquire", "rowId": firstRow})
		if lock := adminWS.await("lock"); lock["by"] != admin.user.Id.String() {
			t.Fatalf("lock: %v", lock)
		}
		workerWS.send(map[string]any{"t": "lock.acquire", "rowId": firstRow})
		if denied := workerWS.await("lock.denied"); denied["by"] != admin.user.Id.String() {
			t.Fatalf("lock.denied: %v", denied)
		}
		// The REST write path honours the same lock.
		rows := decode[gen.ParticipantList](t, c.do("GET", "/api/v1/projects/"+projectID+"/participants", worker.access, "", nil).expect(t, 200))
		if code := c.do("PATCH", "/api/v1/participants/"+firstRow, worker.access, "", gen.UpdateParticipantRequest{Version: rows.Items[0].Version, Name: ptr("blocked")}).errCode(t, 409); code != "ROW_LOCKED" {
			t.Fatalf("code %s", code)
		}
		// Edits made over REST reach the room.
		c.do("PATCH", "/api/v1/participants/"+rows.Items[1].Id.String(), admin.access, "", gen.UpdateParticipantRequest{Version: rows.Items[1].Version, Phone: ptr("+998900000000")}).expect(t, 200)
		upsert := workerWS.await("rows.upsert")
		if items, _ := upsert["items"].([]any); len(items) != 1 {
			t.Fatalf("rows.upsert: %v", upsert)
		}
	})

	t.Run("deactivation closes the user's sockets", func(t *testing.T) {
		workerWS, _ := dialWS(t, srv, projectID, worker.access)
		c.do("PATCH", "/api/v1/admin/users/"+userID, admin.access, "", map[string]any{"isActive": false}).expect(t, 200)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, _, err := workerWS.conn.Read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
			t.Fatalf("expected close 1008, got %v", err)
		}
	})

	t.Run("admin commands", func(t *testing.T) {
		ctx := context.Background()
		var out bytes.Buffer
		if err := a.adminCreate(ctx, "Ops1", "", &out); err != nil {
			t.Fatal(err)
		}
		_, temp, ok := strings.Cut(out.String(), "temporary password: ")
		if !ok {
			t.Fatalf("no password printed: %q", out.String())
		}
		ops, r := c.login("ops1", strings.Fields(temp)[0])
		r.expect(t, 200)
		if !ops.user.PasswordTemporary || ops.user.Roles[0].Name != "admin" {
			t.Fatalf("created admin: %+v", ops.user)
		}
		if err := a.adminCreate(ctx, "ops1", "", &out); err == nil {
			t.Fatal("creating an existing user must fail")
		}
		out.Reset()
		if err := a.adminResetPassword(ctx, "ops1", "chosen-password-9", &out); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(out.String(), "chosen-password-9") {
			t.Fatal("a supplied password must not be echoed")
		}
		c.do("GET", "/api/v1/me", ops.access, "", nil).errCode(t, 401)
		if s := c.mustLogin("ops1", "chosen-password-9"); s.user.PasswordTemporary {
			t.Fatal("a supplied password is permanent")
		}
	})

	t.Run("metrics are recorded", func(t *testing.T) {
		c.do("POST", "/api/v1/projects/"+projectID+"/participants/printed", admin.access, "", map[string]any{"ids": []string{firstRow}}).expect(t, 204)
		rec := httptest.NewRecorder()
		a.metrics.NewInternalServer(":0").Handler.ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
		for _, want := range []string{
			`tip_logins_total{result="ok"}`, `tip_logins_total{result="bad_credentials"}`, `tip_blacklist_checks_total{result="ok"}`, `tip_token_refresh_total{result="ok"}`, "tip_redis_up 1", "tip_ws_connections",
			// Refresh outcomes seen in the "refresh rotation" subtest.
			`tip_token_refresh_total{result="idempotent_replay"} 1`, `tip_token_refresh_total{result="reuse_detected"} 1`, `tip_token_refresh_total{result="invalid"}`,
			// 2 rows added, 1 edited by the worker, 1 added elsewhere, 1 edited over REST while locked by the admin's socket.
			"tip_participants_written_total 5", "tip_tickets_printed_total 1",
			`tip_uploads_total{kind="project_image",result="ok"} 1`,
			`tip_rate_limited_total{kind="ws"} 0`,
			`tip_db_query_duration_seconds_bucket{query="insert"`, `tip_db_query_duration_seconds_bucket{query="select"`,
			"tip_blacklist_check_duration_seconds_count", `tip_http_response_bytes_bucket{route="/api/v1/projects/{id}/image"`,
			"tip_ws_locks_active", "tip_data_dir_free_bytes", "tip_uploads_bytes", "tip_db_size_bytes",
		} {
			if !strings.Contains(rec.Body.String(), want) {
				t.Errorf("missing metric %s", want)
			}
		}
	})
}

func ptr[T any](v T) *T { return &v }
