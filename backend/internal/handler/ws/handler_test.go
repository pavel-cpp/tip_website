package ws

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/repository/memory" //nolint:depguard // integration test wires the real hub
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

// fakeAuth maps tokens of the form "user[:perm,perm][@expiry]" to actors. The
// default permission set is a full operator. Expiry is a Go duration from now.
type fakeAuth struct{}

var allPerms = []domain.Permission{
	domain.PermProjectView, domain.PermParticipantView, domain.PermParticipantEdit,
}

func (fakeAuth) Authenticate(_ context.Context, token string) (domain.Actor, error) {
	if token == "" || strings.HasPrefix(token, "bad") {
		return domain.Actor{}, domain.ErrUnauthenticated
	}
	if strings.HasPrefix(token, "stale") {
		return domain.Actor{}, domain.ErrTokenStale
	}
	if strings.HasPrefix(token, "down") {
		return domain.Actor{}, domain.ErrAuthUnavailable
	}
	var exp time.Time
	if i := strings.Index(token, "@"); i >= 0 {
		d, err := time.ParseDuration(token[i+1:])
		if err != nil {
			return domain.Actor{}, domain.ErrUnauthenticated
		}
		exp = time.Now().Add(d)
		token = token[:i]
	}
	perms := allPerms
	user := token
	if i := strings.Index(token, ":"); i >= 0 {
		user = token[:i]
		perms = nil
		for _, p := range strings.Split(token[i+1:], ",") {
			if p != "" {
				perms = append(perms, domain.Permission(p))
			}
		}
	}
	return domain.Actor{UserID: user, Perms: domain.NewPermissionSet(perms...), TokenExp: exp}, nil
}

type fakeAccess struct{}

func (fakeAccess) EnsureVisible(_ context.Context, _ domain.Actor, projectID string) error {
	if projectID == "hidden" {
		return domain.ErrNotFound
	}
	return nil
}

type fakeDir struct{}

func (fakeDir) Peer(_ context.Context, id string) (domain.Peer, error) {
	return domain.Peer{ID: id, DisplayName: "Name " + id, Color: "#112233", AvatarURL: "/avatars/" + id}, nil
}

type env struct {
	t   *testing.T
	hub *memory.Hub
	h   *Handler
	srv *httptest.Server
}

func newEnv(t *testing.T, mod func(*Config)) *env {
	t.Helper()
	hub := memory.NewHub(memory.Config{SweepInterval: 10 * time.Millisecond})
	svc := service.NewCollab(hub, fakeAccess{}, fakeDir{}, fakeAuth{})
	cfg := Config{
		Collab:        svc,
		AuthTimeout:   300 * time.Millisecond,
		ReauthTimeout: 300 * time.Millisecond,
		IdleTimeout:   10 * time.Second,
	}
	if mod != nil {
		mod(&cfg)
	}
	h := New(cfg)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/projects/{id}/ws", func(w http.ResponseWriter, r *http.Request) {
		h.ServeProject(w, r, r.PathValue("id"))
	})
	srv := httptest.NewServer(mux)
	e := &env{t: t, hub: hub, h: h, srv: srv}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = h.Shutdown(ctx)
		srv.Close()
	})
	return e
}

type client struct {
	t *testing.T
	c *websocket.Conn
}

func (e *env) dial(project string, header http.Header) (*client, error) {
	cl, _, err := e.dialStatus(project, header)
	return cl, err
}

// dialStatus is dial that also reports the HTTP status of the upgrade attempt.
func (e *env) dialStatus(project string, header http.Header) (*client, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/api/v1/projects/" + project + "/ws"
	c, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: header})
	status := 0
	if resp != nil {
		status = resp.StatusCode
		if resp.Body != nil {
			_ = resp.Body.Close()
		}
	}
	if err != nil {
		return nil, status, err
	}
	c.SetReadLimit(1 << 20)
	cl := &client{t: e.t, c: c}
	e.t.Cleanup(func() { _ = c.CloseNow() })
	return cl, status, nil
}

func (e *env) connect(project, token string) *client {
	e.t.Helper()
	cl, err := e.dial(project, nil)
	if err != nil {
		e.t.Fatalf("dial: %v", err)
	}
	cl.send(map[string]any{"t": "auth", "token": token})
	return cl
}

// join connects, authenticates and consumes the hello frame.
func (e *env) join(project, token string) (*client, map[string]any) {
	e.t.Helper()
	cl := e.connect(project, token)
	hello := cl.recv()
	if hello["t"] != "hello" {
		e.t.Fatalf("expected hello, got %v", hello)
	}
	return cl, hello
}

func (c *client) send(v any) {
	c.t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		c.t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.c.Write(ctx, websocket.MessageText, data); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *client) recv() map[string]any {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, data, err := c.c.Read(ctx)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		c.t.Fatalf("bad frame %q: %v", data, err)
	}
	return m
}

// recvType skips frames until one with the wanted type arrives.
func (c *client) recvType(want string) map[string]any {
	c.t.Helper()
	for i := 0; i < 20; i++ {
		if m := c.recv(); m["t"] == want {
			return m
		}
	}
	c.t.Fatalf("no %q frame", want)
	return nil
}

// expectClose reads until the server closes and returns the close status and reason.
func (c *client) expectClose() (websocket.StatusCode, string) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		_, _, err := c.c.Read(ctx)
		if err == nil {
			continue
		}
		var ce websocket.CloseError
		if errors.As(err, &ce) {
			return ce.Code, ce.Reason
		}
		c.t.Fatalf("expected a close frame, got %v", err)
	}
}

func (c *client) expectQuiet() {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	if _, data, err := c.c.Read(ctx); err == nil {
		c.t.Fatalf("unexpected frame %s", data)
	}
}

func TestHelloAfterAuth(t *testing.T) {
	e := newEnv(t, nil)
	cl, hello := e.join("p1", "alice")
	if hello["you"] != "alice" {
		t.Fatalf("you = %v", hello["you"])
	}
	peers := hello["peers"].([]any)
	if len(peers) != 1 {
		t.Fatalf("peers = %v", peers)
	}
	p := peers[0].(map[string]any)
	if p["id"] != "alice" || p["displayName"] != "Name alice" || p["color"] != "#112233" || p["avatarUrl"] != "/avatars/alice" {
		t.Fatalf("peer = %v", p)
	}
	if _, ok := hello["cursors"].(map[string]any); !ok {
		t.Fatalf("cursors = %v", hello["cursors"])
	}
	if _, ok := hello["locks"].(map[string]any); !ok {
		t.Fatalf("locks = %v", hello["locks"])
	}
	if _, err := time.Parse(time.RFC3339Nano, hello["serverTime"].(string)); err != nil {
		t.Fatalf("serverTime: %v", err)
	}
	_ = cl
}

func TestAuthFailuresCloseWith1008(t *testing.T) {
	tests := []struct {
		name      string
		first     any
		wantCode  websocket.StatusCode
		wantError string
	}{
		{"bad token", map[string]any{"t": "auth", "token": "bad"}, websocket.StatusPolicyViolation, "UNAUTHENTICATED"},
		{"stale token", map[string]any{"t": "auth", "token": "stale"}, websocket.StatusPolicyViolation, "TOKEN_STALE"},
		{"first frame is not auth", map[string]any{"t": "ping"}, websocket.StatusPolicyViolation, "UNAUTHENTICATED"},
		{"missing token", map[string]any{"t": "auth"}, websocket.StatusPolicyViolation, "UNAUTHENTICATED"},
		{"no project.view", map[string]any{"t": "auth", "token": "u:participant.view"}, websocket.StatusPolicyViolation, "FORBIDDEN"},
		{"no participant.view", map[string]any{"t": "auth", "token": "u:project.view"}, websocket.StatusPolicyViolation, "FORBIDDEN"},
		{"auth backend down", map[string]any{"t": "auth", "token": "down"}, websocket.StatusTryAgainLater, "AUTH_UNAVAILABLE"},
		{"already expired", map[string]any{"t": "auth", "token": "u@-1s"}, websocket.StatusPolicyViolation, "TOKEN_EXPIRED"},
	}
	e := newEnv(t, nil)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cl, err := e.dial("p1", nil)
			if err != nil {
				t.Fatal(err)
			}
			cl.send(tt.first)
			if f := cl.recv(); f["t"] != "error" || f["code"] != tt.wantError {
				t.Fatalf("error frame = %v", f)
			}
			if code, reason := cl.expectClose(); code != tt.wantCode || reason != tt.wantError {
				t.Fatalf("close = %d %q", code, reason)
			}
		})
	}
}

func TestHiddenProjectClosesWithNotFound(t *testing.T) {
	e := newEnv(t, nil)
	cl := e.connect("hidden", "alice")
	if f := cl.recv(); f["code"] != "NOT_FOUND" {
		t.Fatalf("frame = %v", f)
	}
	if code, _ := cl.expectClose(); code != websocket.StatusPolicyViolation {
		t.Fatalf("close code = %d", code)
	}
}

func TestMissingAuthFrameTimesOut(t *testing.T) {
	e := newEnv(t, nil)
	cl, err := e.dial("p1", nil)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	code, reason := cl.expectClose()
	if code != websocket.StatusPolicyViolation || reason != "AUTH_TIMEOUT" {
		t.Fatalf("close = %d %q", code, reason)
	}
	if time.Since(start) < 250*time.Millisecond {
		t.Fatalf("closed too early: %v", time.Since(start))
	}
}

func TestOriginCheck(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.AllowedOrigins = []string{"https://tip.example.com"} })

	if _, status, err := e.dialStatus("p1", http.Header{"Origin": {"https://evil.example.org"}}); err == nil {
		t.Fatal("foreign origin must be rejected")
	} else if status != http.StatusForbidden {
		t.Fatalf("status = %d", status)
	}
	if cl, err := e.dial("p1", http.Header{"Origin": {"https://tip.example.com"}}); err != nil {
		t.Fatalf("allowed origin rejected: %v", err)
	} else {
		cl.send(map[string]any{"t": "auth", "token": "alice"})
		cl.recvType("hello")
	}
	same := e.srv.URL // same origin as the server host
	if _, err := e.dial("p1", http.Header{"Origin": {same}}); err != nil {
		t.Fatalf("same origin rejected: %v", err)
	}
}

func TestCompressionIsDisabled(t *testing.T) {
	e := newEnv(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/api/v1/projects/p1/ws"
	c, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{CompressionMode: websocket.CompressionContextTakeover})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow() //nolint:errcheck // test cleanup
	ext := resp.Header.Get("Sec-WebSocket-Extensions")
	if resp.Body != nil {
		_ = resp.Body.Close()
	}
	if ext != "" {
		t.Fatalf("server negotiated extensions: %q", ext)
	}
}

func TestPresenceBetweenClients(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice")
	b, helloB := e.join("p1", "bob")
	if len(helloB["peers"].([]any)) != 2 {
		t.Fatalf("bob hello peers = %v", helloB["peers"])
	}
	pres := a.recvType("presence")
	if len(pres["peers"].([]any)) != 2 {
		t.Fatalf("presence = %v", pres)
	}
	_ = b.c.Close(websocket.StatusNormalClosure, "bye")
	pres = a.recvType("presence")
	if len(pres["peers"].([]any)) != 1 {
		t.Fatalf("presence after leave = %v", pres)
	}
}

func TestLockProtocol(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice")
	b, _ := e.join("p1", "bob")
	a.recvType("presence")

	a.send(map[string]any{"t": "lock.acquire", "rowId": "r1"})
	la := a.recvType("lock")
	lb := b.recvType("lock")
	for _, f := range []map[string]any{la, lb} {
		if f["rowId"] != "r1" || f["by"] != "alice" {
			t.Fatalf("lock frame = %v", f)
		}
		if _, err := time.Parse(time.RFC3339Nano, f["expiresAt"].(string)); err != nil {
			t.Fatalf("expiresAt: %v", err)
		}
	}

	b.send(map[string]any{"t": "lock.acquire", "rowId": "r1"})
	if d := b.recvType("lock.denied"); d["rowId"] != "r1" || d["by"] != "alice" {
		t.Fatalf("denied = %v", d)
	}

	// The REST path sees the same lock through the hub.
	if err := e.hub.EnsureFree(context.Background(), "r1", "bob"); !errors.Is(err, domain.ErrRowLocked) {
		t.Fatalf("EnsureFree = %v", err)
	}

	a.send(map[string]any{"t": "ping"})
	a.send(map[string]any{"t": "lock.release", "rowId": "r1"})
	for _, c := range []*client{a, b} {
		if u := c.recvType("unlock"); u["rowId"] != "r1" || u["by"] != "alice" {
			t.Fatalf("unlock = %v", u)
		}
	}
}

func TestLockReleasedWhenClientDisconnects(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice")
	b, _ := e.join("p1", "bob")
	a.recvType("presence")
	a.send(map[string]any{"t": "lock.acquire", "rowId": "r1"})
	b.recvType("lock")
	_ = a.c.CloseNow()
	if u := b.recvType("unlock"); u["rowId"] != "r1" {
		t.Fatalf("unlock = %v", u)
	}
}

func TestViewerCannotLock(t *testing.T) {
	e := newEnv(t, nil)
	v, _ := e.join("p1", "viewer:project.view,participant.view")
	v.send(map[string]any{"t": "lock.acquire", "rowId": "r1"})
	if f := v.recv(); f["t"] != "error" || f["code"] != "FORBIDDEN" {
		t.Fatalf("frame = %v", f)
	}
	// The connection stays usable.
	v.send(map[string]any{"t": "cursor", "rowId": "r1", "field": "name"})
	v.send(map[string]any{"t": "ping"})
	v.expectQuiet()
}

func TestCursorProtocol(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice")
	b, _ := e.join("p1", "bob")
	a.recvType("presence")

	a.send(map[string]any{"t": "cursor", "rowId": "r1", "field": "phone"})
	c := b.recvType("cursor")
	if c["userId"] != "alice" || c["rowId"] != "r1" || c["field"] != "phone" {
		t.Fatalf("cursor = %v", c)
	}
	a.send(map[string]any{"t": "cursor", "rowId": nil})
	c = b.recvType("cursor")
	if c["userId"] != "alice" || c["rowId"] != nil {
		t.Fatalf("cleared cursor = %v", c)
	}

	c2, hello := e.join("p1", "carol")
	_ = c2
	if len(hello["cursors"].(map[string]any)) != 0 {
		t.Fatalf("hello cursors = %v", hello["cursors"])
	}
}

func TestInvalidFramesDoNotCloseConnection(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice")
	for _, raw := range []string{
		`not json`,
		`{"t":"nope"}`,
		`{"t":"lock.acquire"}`,
		`{"t":"lock.release"}`,
		`{"t":"lock.acquire","rowId":""}`,
		`{"t":"cursor","rowId":"` + strings.Repeat("x", 200) + `"}`,
		"{\"t\":\"cursor\",\"rowId\":\"a\\u0000b\"}",
	} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		if err := a.c.Write(ctx, websocket.MessageText, []byte(raw)); err != nil {
			t.Fatal(err)
		}
		cancel()
		if f := a.recv(); f["t"] != "error" || f["code"] != "VALIDATION" {
			t.Fatalf("%s -> %v", raw, f)
		}
	}
	a.send(map[string]any{"t": "ping"})
	a.expectQuiet()
}

func TestBinaryFrameIsRejectedNotFatal(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := a.c.Write(ctx, websocket.MessageBinary, []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	if f := a.recv(); f["code"] != "VALIDATION" {
		t.Fatalf("frame = %v", f)
	}
}

func TestOversizedFrameClosesConnection(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice")
	big := `{"t":"cursor","rowId":"` + strings.Repeat("x", MaxFrameBytes) + `"}`
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = a.c.Write(ctx, websocket.MessageText, []byte(big))
	if code, _ := a.expectClose(); code != websocket.StatusMessageTooBig {
		t.Fatalf("close code = %d", code)
	}
}

func TestRateLimitClosesConnection(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice")
	for i := 0; i < 60; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err := a.c.Write(ctx, websocket.MessageText, []byte(`{"t":"ping"}`))
		cancel()
		if err != nil {
			break
		}
	}
	sawError := false
	for i := 0; i < 70; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, data, err := a.c.Read(ctx)
		cancel()
		if err != nil {
			var ce websocket.CloseError
			if !errors.As(err, &ce) || ce.Code != websocket.StatusPolicyViolation || ce.Reason != "RATE_LIMITED" {
				t.Fatalf("read error = %v", err)
			}
			if !sawError {
				t.Fatal("RATE_LIMITED error frame must precede the close")
			}
			return
		}
		if strings.Contains(string(data), "RATE_LIMITED") {
			sawError = true
		}
	}
	t.Fatal("connection was not closed")
}

func TestRowEventsAreForwarded(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice")
	other, _ := e.join("p2", "bob")

	updated := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	e.hub.Publish("p1", domain.RowsUpserted(domain.Participant{
		ID: "r1", ProjectID: "p1", Number: 5, Name: "Azam", Phone: "+998", Version: 7, UpdatedAt: updated,
	}))
	e.hub.Publish("p1", domain.RowsDeleted("r2", "r3"))
	e.hub.Publish("p1", domain.ProjectUpdated(domain.Project{
		ID: "p1", Title: "Tashkent", Status: domain.ProjectFinished, Version: 4,
		Image:        &domain.ImageMeta{SHA256: strings.Repeat("ab", 32), Name: "a.jpg", Width: 10, Height: 20, Bytes: 30},
		Placeholders: domain.Placeholders{Number: domain.Placeholder{Font: "Inter", Size: 30, Color: "#ffffff"}},
	}))

	up := a.recv()
	items := up["items"].([]any)
	row := items[0].(map[string]any)
	if up["t"] != "rows.upsert" || row["id"] != "r1" || row["version"] != float64(7) || row["name"] != "Azam" ||
		row["projectId"] != "p1" || row["number"] != float64(5) || row["updatedAt"] != "2026-11-08T12:00:00Z" {
		t.Fatalf("upsert = %v", up)
	}
	del := a.recv()
	if ids := del["ids"].([]any); del["t"] != "rows.delete" || len(ids) != 2 || ids[0] != "r2" {
		t.Fatalf("delete = %v", del)
	}
	pr := a.recv()
	p := pr["project"].(map[string]any)
	img := p["image"].(map[string]any)
	ph := p["placeholders"].(map[string]any)
	if pr["t"] != "project.updated" || p["status"] != "finished" || p["title"] != "Tashkent" || p["version"] != float64(4) ||
		img["url"] != "/api/v1/projects/p1/image?v=abababab" || ph["number"].(map[string]any)["font"] != "Inter" {
		t.Fatalf("project = %v", pr)
	}
	other.expectQuiet()
}

func TestReauthRenewalKeepsConnection(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice")
	e.hub.BroadcastReauth("alice")
	a.recvType("reauth")
	a.send(map[string]any{"t": "auth", "token": "alice"})
	time.Sleep(450 * time.Millisecond) // longer than ReauthTimeout
	a.send(map[string]any{"t": "cursor", "rowId": "r1"})
	a.send(map[string]any{"t": "lock.acquire", "rowId": "r1"})
	a.recvType("lock") // still alive and permitted
}

func TestReauthTimeoutCloses(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice")
	e.hub.BroadcastReauth("")
	a.recvType("reauth")
	if code, reason := a.expectClose(); code != websocket.StatusPolicyViolation || reason != "REAUTH_TIMEOUT" {
		t.Fatalf("close = %d %q", code, reason)
	}
}

func TestReauthWithReducedRightsCloses(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice")
	a.send(map[string]any{"t": "auth", "token": "alice:participant.view"}) // lost project.view
	if f := a.recv(); f["code"] != "FORBIDDEN" {
		t.Fatalf("frame = %v", f)
	}
	if code, _ := a.expectClose(); code != websocket.StatusPolicyViolation {
		t.Fatalf("close code = %d", code)
	}
}

func TestReauthWithOtherUsersTokenCloses(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice")
	a.send(map[string]any{"t": "auth", "token": "mallory"})
	if code, _ := a.expectClose(); code != websocket.StatusPolicyViolation {
		t.Fatalf("close code = %d", code)
	}
}

func TestReauthWithBadTokenCloses(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice")
	a.send(map[string]any{"t": "auth", "token": "stale"})
	if f := a.recv(); f["code"] != "TOKEN_STALE" {
		t.Fatalf("frame = %v", f)
	}
	if code, _ := a.expectClose(); code != websocket.StatusPolicyViolation {
		t.Fatalf("close code = %d", code)
	}
}

func TestTokenMustNotOutliveExpiry(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice@400ms")
	// Renew before the deadline: the connection survives the original expiry.
	time.Sleep(150 * time.Millisecond)
	a.send(map[string]any{"t": "auth", "token": "alice@700ms"})
	time.Sleep(400 * time.Millisecond) // past the first expiry
	a.send(map[string]any{"t": "cursor", "rowId": "r1"})
	// Not renewed again: closed with 1008 at the new expiry.
	code, reason := a.expectClose()
	if code != websocket.StatusPolicyViolation || reason != "TOKEN_EXPIRED" {
		t.Fatalf("close = %d %q", code, reason)
	}
}

func TestKickUserClosesWith1008(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice")
	b, _ := e.join("p1", "bob")
	a.recvType("presence")
	e.hub.KickUser("alice")
	if code, _ := a.expectClose(); code != websocket.StatusPolicyViolation {
		t.Fatalf("close code = %d", code)
	}
	pres := b.recvType("presence")
	if len(pres["peers"].([]any)) != 1 {
		t.Fatalf("presence = %v", pres)
	}
}

func TestShutdownClosesWith1001(t *testing.T) {
	e := newEnv(t, nil)
	a, _ := e.join("p1", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- e.h.Shutdown(ctx) }()
	if code, _ := a.expectClose(); code != websocket.StatusGoingAway {
		t.Fatalf("close code = %d", code)
	}
	if err := <-done; err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	// New connections are refused afterwards.
	if _, status, err := e.dialStatus("p1", nil); err == nil || status != http.StatusServiceUnavailable {
		t.Fatalf("dial after shutdown: %d %v", status, err)
	}
}

func TestIdleConnectionIsClosed(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.IdleTimeout = 200 * time.Millisecond })
	a, _ := e.join("p1", "alice")
	if code, reason := a.expectClose(); code != websocket.StatusPolicyViolation || reason != "IDLE_TIMEOUT" {
		t.Fatalf("close = %d %q", code, reason)
	}
}

func TestPingKeepsConnectionAlive(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.IdleTimeout = 250 * time.Millisecond })
	a, _ := e.join("p1", "alice")
	for i := 0; i < 5; i++ {
		time.Sleep(100 * time.Millisecond)
		a.send(map[string]any{"t": "ping"})
	}
	a.expectQuiet()
}
