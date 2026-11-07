package http

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/pavel-cpp/tip_website/backend/internal/platform/logging"
)

type clientErrorsEnv struct {
	h   http.Handler
	log *bytes.Buffer
	now *time.Time
}

func newClientErrorsEnv() clientErrorsEnv {
	var buf bytes.Buffer
	now := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	ce := NewClientErrorsHandler(func() time.Time { return now })
	base := zerolog.New(&buf)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := logging.WithLogger(r.Context(), base)
		ce.ReportClientError(w, r.WithContext(ctx))
	})
	return clientErrorsEnv{h: h, log: &buf, now: &now}
}

func (e clientErrorsEnv) post(body, addr string) *httptest.ResponseRecorder {
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/v1/client-errors", strings.NewReader(body))
	req.RemoteAddr = addr
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

func TestClientErrorAcceptedAndLogged(t *testing.T) {
	e := newClientErrorsEnv()
	rec := e.post(`{"message":"boom","stack":"at x","url":"https://tip.example/projects/1?token=secret#frag","ua":"UA/1","release":"1.2.3"}`, "10.0.0.1:5555")
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
		t.Fatalf("status = %d body=%q", rec.Code, rec.Body.String())
	}
	var line map[string]any
	if err := json.Unmarshal(e.log.Bytes(), &line); err != nil {
		t.Fatalf("log line: %v: %s", err, e.log.String())
	}
	want := map[string]any{
		"source": "browser", "message": "boom", "stack": "at x", "ua": "UA/1", "release": "1.2.3",
		"url": "https://tip.example/projects/1", "level": "warn",
	}
	for k, v := range want {
		if line[k] != v {
			t.Errorf("log[%s] = %v, want %v", k, line[k], v)
		}
	}
	if strings.Contains(e.log.String(), "secret") {
		t.Error("query string leaked into the log")
	}
}

func TestClientErrorMinimalReport(t *testing.T) {
	e := newClientErrorsEnv()
	if rec := e.post(`{"message":"x"}`, "10.0.0.1:1"); rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestClientErrorValidation(t *testing.T) {
	long := func(n int) string { return strings.Repeat("a", n) }
	cases := map[string]string{
		"missing message":  `{}`,
		"empty message":    `{"message":""}`,
		"long message":     `{"message":"` + long(2001) + `"}`,
		"long stack":       `{"message":"m","stack":"` + long(4001) + `"}`,
		"long url":         `{"message":"m","url":"` + long(1001) + `"}`,
		"long ua":          `{"message":"m","ua":"` + long(501) + `"}`,
		"long release":     `{"message":"m","release":"` + long(65) + `"}`,
		"unknown field":    `{"message":"m","email":"a@b.c"}`,
		"malformed":        `{"message":`,
		"empty body":       ``,
		"trailing garbage": `{"message":"m"} {}`,
	}
	for name, body := range cases {
		e := newClientErrorsEnv()
		rec := e.post(body, "10.0.0.1:1")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, rec.Code)
		}
		if e.log.Len() != 0 && strings.Contains(e.log.String(), `"source":"browser"`) {
			t.Errorf("%s: invalid report must not be logged as a client error", name)
		}
	}
}

func TestClientErrorBodyLimit(t *testing.T) {
	e := newClientErrorsEnv()
	body := `{"message":"m","stack":"` + strings.Repeat("a", 9000) + `"}`
	if rec := e.post(body, "10.0.0.1:1"); rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", rec.Code)
	}
}

func TestClientErrorRateLimitPerIP(t *testing.T) {
	e := newClientErrorsEnv()
	for i := 0; i < clientErrorRatePerMin; i++ {
		if rec := e.post(`{"message":"m"}`, "10.0.0.1:1"); rec.Code != http.StatusNoContent {
			t.Fatalf("request %d: %d", i, rec.Code)
		}
	}
	rec := e.post(`{"message":"m"}`, "10.0.0.1:2") // same IP, other port
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("429 must carry Retry-After")
	}
	if rec := e.post(`{"message":"m"}`, "10.0.0.2:1"); rec.Code != http.StatusNoContent {
		t.Errorf("another IP must not be limited: %d", rec.Code)
	}
	*e.now = e.now.Add(time.Minute)
	if rec := e.post(`{"message":"m"}`, "10.0.0.1:1"); rec.Code != http.StatusNoContent {
		t.Errorf("the window must reset: %d", rec.Code)
	}
}

func TestClientErrorLimiterIsBounded(t *testing.T) {
	now := time.Unix(0, 0)
	l := newClientErrorLimiter(1, time.Minute, func() time.Time { return now })
	for i := 0; i < clientErrorLimiterCap; i++ {
		if ok, _ := l.allow(strings.Repeat("k", 1) + string(rune('a'+i%26)) + time.Duration(i).String()); !ok {
			t.Fatalf("key %d refused before the cap", i)
		}
	}
	if ok, _ := l.allow("overflow"); ok {
		t.Error("a full limiter with live entries must refuse new keys")
	}
	now = now.Add(2 * time.Minute)
	if ok, _ := l.allow("overflow"); !ok {
		t.Error("expired entries must be swept to make room")
	}
	if len(l.entries) > clientErrorLimiterCap {
		t.Errorf("entries = %d", len(l.entries))
	}
}
