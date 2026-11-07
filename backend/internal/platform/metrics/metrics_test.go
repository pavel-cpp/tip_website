package metrics

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	_ "github.com/jackc/pgx/v5/stdlib" // registers the driver; sql.Open is lazy so no server is needed
)

func scrape(t *testing.T, m *Metrics) string {
	t.Helper()
	srv := m.NewInternalServer(":0")
	rec := httptest.NewRecorder()
	srv.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("metrics status %d", rec.Code)
	}
	return rec.Body.String()
}

func TestMiddlewareUsesRoutePattern(t *testing.T) {
	m := New("v1", "abc")
	r := chi.NewRouter()
	r.Use(m.Middleware)
	r.Get("/items/{id}", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })

	for _, path := range []string{"/items/1", "/items/2", "/nope/123"} {
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
	}
	out := scrape(t, m)
	for _, want := range []string{
		`tip_http_requests_total{method="GET",route="/items/{id}",status="418"} 2`,
		`tip_http_requests_total{method="GET",route="unmatched",status="404"} 1`,
		`tip_http_request_duration_seconds_bucket{method="GET",route="/items/{id}"`,
		`tip_http_in_flight 0`,
		`tip_build_info{commit="abc",version="v1"} 1`,
		`tip_log_dropped_total 0`,
		`go_goroutines`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(out, "/items/1") {
		t.Error("raw paths must not appear as label values")
	}
}

func TestLogDroppedCounter(t *testing.T) {
	m := New("v", "c")
	m.LogDropped.Add(3)
	if !strings.Contains(scrape(t, m), "tip_log_dropped_total 3") {
		t.Error("dropped counter not exposed")
	}
}

func TestDBCollector(t *testing.T) {
	db, err := sql.Open("pgx", "postgres://u:p@127.0.0.1:1/x")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(7)
	m := New("v", "c")
	m.RegisterDB(db)
	out := scrape(t, m)
	for _, want := range []string{"tip_db_max_open_connections 7", "tip_db_open_connections 0", "tip_db_wait_count_total 0"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
}

func TestPprofServed(t *testing.T) {
	srv := New("v", "c").NewInternalServer(":0")
	for _, path := range []string{"/debug/pprof/", "/debug/pprof/goroutine?debug=1", "/debug/pprof/cmdline"} {
		rec := httptest.NewRecorder()
		srv.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status %d", path, rec.Code)
		}
	}
}
