package metrics

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestQueryKind(t *testing.T) {
	for sql, want := range map[string]string{
		"SELECT 1":                             "select",
		"  \n select * from t":                 "select",
		"WITH x AS (SELECT 1) SELECT * FROM x": "select",
		"INSERT INTO t VALUES ($1)":            "insert",
		"update t set a = 1":                   "update",
		"DELETE FROM t":                        "delete",
		"begin":                                "tx",
		"COMMIT":                               "tx",
		"rollback":                             "tx",
		"SET lock_timeout = 1":                 "other",
		"":                                     "other",
	} {
		if got := QueryKind(sql); got != want {
			t.Errorf("QueryKind(%q) = %q, want %q", sql, got, want)
		}
	}
}

func TestObserveQuery(t *testing.T) {
	m := New("v", "c")
	m.ObserveQuery("select", 20*time.Millisecond)
	m.ObserveQuery("select", 30*time.Millisecond)
	out := scrape(t, m)
	for _, want := range []string{
		`tip_db_query_duration_seconds_count{query="select"} 2`,
		`tip_db_query_duration_seconds_count{query="tx"} 0`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
}

func TestResponseBytesAndRateLimited(t *testing.T) {
	m := New("v", "c")
	r := chi.NewRouter()
	r.Use(m.Middleware)
	r.Get("/items/{id}", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(strings.Repeat("x", 300))) })
	r.Post("/api/v1/auth/login", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTooManyRequests) })
	r.Post("/api/v1/client-errors", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTooManyRequests) })
	r.Get("/api/v1/other", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTooManyRequests) })

	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/items/1", nil))
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil))
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/v1/client-errors", nil))
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/v1/other", nil))

	out := scrape(t, m)
	for _, want := range []string{
		`tip_http_response_bytes_count{route="/items/{id}"} 1`,
		`tip_http_response_bytes_sum{route="/items/{id}"} 300`,
		`tip_http_response_bytes_bucket{route="/items/{id}",le="256"} 0`,
		`tip_http_response_bytes_bucket{route="/items/{id}",le="1024"} 1`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
	for kind, want := range map[string]float64{"login": 1, "client_errors": 1, "api": 1, "ws": 0} {
		if got := testutil.ToFloat64(m.RateLimited.WithLabelValues(kind)); got != want {
			t.Errorf("rate_limited{%s} = %v, want %v", kind, got, want)
		}
	}
}

func TestBusinessCounters(t *testing.T) {
	m := New("v", "c")
	m.ParticipantsWritten.Add(5)
	m.TicketsPrinted.Add(3)
	m.Uploads.WithLabelValues("avatar", "ok").Inc()
	m.Uploads.WithLabelValues("project_image", "rejected").Inc()
	m.BlacklistDuration.Observe(0.002)
	m.TokenRefresh.WithLabelValues("reuse_detected").Inc()
	m.TokenRefresh.WithLabelValues("idempotent_replay").Add(2)

	if got := testutil.ToFloat64(m.ParticipantsWritten); got != 5 {
		t.Errorf("participants written = %v", got)
	}
	if got := testutil.ToFloat64(m.TicketsPrinted); got != 3 {
		t.Errorf("tickets printed = %v", got)
	}
	out := scrape(t, m)
	for _, want := range []string{
		`tip_uploads_total{kind="avatar",result="ok"} 1`,
		`tip_uploads_total{kind="project_image",result="rejected"} 1`,
		`tip_uploads_total{kind="avatar",result="error"} 0`,
		`tip_blacklist_check_duration_seconds_count 1`,
		`tip_token_refresh_total{result="reuse_detected"} 1`,
		`tip_token_refresh_total{result="idempotent_replay"} 2`,
		`tip_token_refresh_total{result="ok"} 0`,
		`tip_participants_written_total 5`,
		`tip_tickets_printed_total 3`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
}

func TestRegisterLocks(t *testing.T) {
	m := New("v", "c")
	n := 4
	m.RegisterLocks(func() int { return n })
	if !strings.Contains(scrape(t, m), "tip_ws_locks_active 4") {
		t.Error("locks gauge missing")
	}
	n = 1
	if !strings.Contains(scrape(t, m), "tip_ws_locks_active 1") {
		t.Error("locks gauge not read at scrape time")
	}
}

func TestStorageCollectorCachesExpensiveProbes(t *testing.T) {
	m := New("v", "c")
	now := time.Unix(1000, 0)
	var walks, sizes, frees int
	var dirRoot string
	m.RegisterStorage(StorageProbes{
		DataDir: "/data",
		DiskFree: func(string) (uint64, uint64, error) {
			frees++
			return 12345, 99999, nil
		},
		DirSize: func(_ context.Context, root string) (int64, error) {
			walks++
			dirRoot = root
			return 777, nil
		},
		DBSize: func(context.Context) (int64, error) {
			sizes++
			return 4242, nil
		},
		TTL: time.Minute,
		Now: func() time.Time { return now },
	})

	out := scrape(t, m)
	for _, want := range []string{"tip_data_dir_free_bytes 12345", "tip_uploads_bytes 777", "tip_db_size_bytes 4242"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
	if !strings.HasSuffix(strings.ReplaceAll(dirRoot, `\`, "/"), "/data/uploads") {
		t.Errorf("uploads measured at %q", dirRoot)
	}

	now = now.Add(15 * time.Second)
	scrape(t, m)
	if walks != 1 || sizes != 1 || frees != 2 {
		t.Errorf("within TTL: walks=%d sizes=%d frees=%d, want 1 1 2", walks, sizes, frees)
	}
	now = now.Add(time.Minute)
	scrape(t, m)
	if walks != 2 || sizes != 2 {
		t.Errorf("after TTL: walks=%d sizes=%d, want 2 2", walks, sizes)
	}
}

func TestStorageCollectorKeepsLastValueOnError(t *testing.T) {
	m := New("v", "c")
	now := time.Unix(1000, 0)
	fail := false
	m.RegisterStorage(StorageProbes{
		DBSize: func(context.Context) (int64, error) {
			if fail {
				return 0, errors.New("db down")
			}
			return 4242, nil
		},
		TTL: time.Second,
		Now: func() time.Time { return now },
	})
	scrape(t, m)
	fail = true
	now = now.Add(time.Minute)
	if !strings.Contains(scrape(t, m), "tip_db_size_bytes 4242") {
		t.Error("last good value must survive a failed refresh")
	}
}

func TestStorageCollectorOmitsNeverMeasured(t *testing.T) {
	m := New("v", "c")
	m.RegisterStorage(StorageProbes{
		DBSize: func(context.Context) (int64, error) { return 0, errors.New("db down") },
	})
	if strings.Contains(scrape(t, m), "tip_db_size_bytes") {
		t.Error("a probe that never succeeded must not report 0")
	}
}
