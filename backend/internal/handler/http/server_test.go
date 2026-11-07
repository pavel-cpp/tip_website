package http

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog"

	"github.com/pavel-cpp/tip_website/backend/internal/platform/metrics"
)

func newTestRouter(t *testing.T, checks ...Check) (http.Handler, *bytes.Buffer, *metrics.Metrics) {
	t.Helper()
	var buf bytes.Buffer
	m := metrics.New("test", "test")
	h := NewRouter(Deps{
		Logger:  zerolog.New(&buf).Level(zerolog.DebugLevel),
		Metrics: m,
		NewID:   func() string { return "generated-id" },
		Ready:   checks,
	})
	return h, &buf, m
}

func do(h http.Handler, method, path string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestWriteErrorEnvelope(t *testing.T) {
	rec := httptest.NewRecorder()
	writeError(rec, http.StatusConflict, "ROW_LOCKED", "row is locked", map[string]string{"by": "u1"})
	var got errorEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if rec.Code != 409 || got.Error.Code != "ROW_LOCKED" || got.Error.Message != "row is locked" {
		t.Errorf("unexpected: %d %+v", rec.Code, got)
	}
	if !strings.Contains(rec.Header().Get("Content-Type"), "application/json") {
		t.Error("content type must be JSON")
	}
	rec = httptest.NewRecorder()
	writeError(rec, 400, "VALIDATION", "bad", nil)
	if !strings.Contains(rec.Body.String(), `"details":{}`) {
		t.Errorf("nil details must render as an empty object: %s", rec.Body.String())
	}
}

func TestRequestID(t *testing.T) {
	h, _, _ := newTestRouter(t)
	if got := do(h, "GET", "/healthz", nil).Header().Get(requestIDHeader); got != "generated-id" {
		t.Errorf("generated id = %q", got)
	}
	if got := do(h, "GET", "/healthz", map[string]string{requestIDHeader: "client-1"}).Header().Get(requestIDHeader); got != "client-1" {
		t.Errorf("incoming id not accepted: %q", got)
	}
	if got := do(h, "GET", "/healthz", map[string]string{requestIDHeader: "bad id\r\nx"}).Header().Get(requestIDHeader); got != "generated-id" {
		t.Errorf("unsafe id must be replaced: %q", got)
	}
}

func TestSecurityHeaders(t *testing.T) {
	h, _, _ := newTestRouter(t)
	rec := do(h, "GET", "/healthz", nil)
	if !strings.Contains(rec.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") ||
		rec.Header().Get("X-Content-Type-Options") != "nosniff" || rec.Header().Get("Referrer-Policy") == "" {
		t.Errorf("missing security headers: %v", rec.Header())
	}
}

func TestPanicRecovery(t *testing.T) {
	var buf bytes.Buffer
	l := zerolog.New(&buf)
	r := chi.NewRouter()
	r.Use(requestIDMiddleware(func() string { return "rid" }, l), accessLogMiddleware, recoverMiddleware)
	r.Get("/boom", func(http.ResponseWriter, *http.Request) { panic("secret detail") })

	rec := do(r, "GET", "/boom", nil)
	if rec.Code != 500 {
		t.Fatalf("status %d", rec.Code)
	}
	var env errorEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil || env.Error.Code != codeInternal {
		t.Fatalf("bad envelope: %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "secret detail") {
		t.Error("panic details must not reach the client")
	}
	out := buf.String()
	if !strings.Contains(out, `"level":"error"`) || !strings.Contains(out, "secret detail") ||
		!strings.Contains(out, `"request_id":"rid"`) || !strings.Contains(out, `"status":500`) {
		t.Errorf("panic not logged properly: %s", out)
	}
}

func TestAccessLogUsesRoutePatternAndSkipsProbes(t *testing.T) {
	var buf bytes.Buffer
	r := chi.NewRouter()
	r.Use(requestIDMiddleware(func() string { return "rid" }, zerolog.New(&buf).Level(zerolog.InfoLevel)), accessLogMiddleware)
	r.Get("/items/{id}", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	r.Get("/healthz", func(http.ResponseWriter, *http.Request) {})

	do(r, "GET", "/items/42", nil)
	do(r, "GET", "/healthz", nil)
	out := buf.String()
	if strings.Count(out, "\n") != 1 {
		t.Fatalf("probes must not be logged at INFO: %s", out)
	}
	for _, want := range []string{`"route":"/items/{id}"`, `"status":200`, `"bytes":2`, `"method":"GET"`, `"request_id":"rid"`, `"dur_ms":`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %s in %s", want, out)
		}
	}
	if strings.Contains(out, "/items/42") {
		t.Error("raw path must not be logged")
	}
}

func TestHealthzAndReadyz(t *testing.T) {
	h, _, _ := newTestRouter(t, Check{Name: "db", Fn: func(context.Context) error { return nil }})
	if rec := do(h, "GET", "/healthz", nil); rec.Code != 200 {
		t.Errorf("healthz %d", rec.Code)
	}
	if rec := do(h, "GET", "/readyz", nil); rec.Code != 200 {
		t.Errorf("readyz %d", rec.Code)
	}

	h, buf, _ := newTestRouter(t, Check{Name: "db", Fn: func(context.Context) error { return errors.New("down") }})
	rec := do(h, "GET", "/readyz", nil)
	if rec.Code != 503 || !strings.Contains(rec.Body.String(), `"db"`) {
		t.Errorf("readyz failure: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "down") {
		t.Error("check error text must not reach the client")
	}
	if !strings.Contains(buf.String(), "readiness check failed") {
		t.Error("failed check must be logged")
	}
}

func TestNotFoundAndMethodNotAllowed(t *testing.T) {
	h, _, _ := newTestRouter(t)
	rec := do(h, "GET", "/nope", nil)
	if rec.Code != 404 || !strings.Contains(rec.Body.String(), `"NOT_FOUND"`) {
		t.Errorf("404: %d %s", rec.Code, rec.Body.String())
	}
	rec = do(h, "POST", "/healthz", nil)
	if rec.Code != 405 || !strings.Contains(rec.Body.String(), `"METHOD_NOT_ALLOWED"`) {
		t.Errorf("405: %d %s", rec.Code, rec.Body.String())
	}
}

func TestMetricsMiddlewareWired(t *testing.T) {
	h, _, m := newTestRouter(t)
	do(h, "GET", "/healthz", nil)
	rec := httptest.NewRecorder()
	m.NewInternalServer(":0").Handler.ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	if !strings.Contains(rec.Body.String(), `tip_http_requests_total{method="GET",route="/healthz",status="200"} 1`) {
		t.Error("request not counted")
	}
}
