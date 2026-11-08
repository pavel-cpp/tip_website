// Package metrics owns the Prometheus registry, HTTP instrumentation and the internal
// (non-public) server that exposes /metrics and pprof.
package metrics

import (
	"database/sql"
	"net/http"
	"net/http/pprof"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// unmatchedRoute is the route label for requests no pattern handled; it keeps cardinality bounded.
const unmatchedRoute = "unmatched"

// Metrics bundles the registry and the instruments shared across the process.
type Metrics struct {
	Registry   *prometheus.Registry
	LogDropped prometheus.Counter

	// RedisUp is 1 while the token store answers its periodic ping, 0 otherwise.
	RedisUp prometheus.Gauge
	// BlacklistChecks counts access-token revocation lookups by result: ok, revoked or error.
	BlacklistChecks *prometheus.CounterVec
	// TokenRefresh counts refresh attempts by result.
	TokenRefresh *prometheus.CounterVec
	// Logins counts login attempts by result.
	Logins *prometheus.CounterVec

	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
	inFlight prometheus.Gauge
}

// New creates the registry with Go, process, build info and HTTP instruments registered.
func New(version, commit string) *Metrics {
	m := &Metrics{
		Registry: prometheus.NewRegistry(),
		LogDropped: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "tip_log_dropped_total",
			Help: "Log events dropped by the non-blocking logger buffer.",
		}),
		RedisUp: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "tip_redis_up",
			Help: "1 when the last Redis ping succeeded, 0 when it failed.",
		}),
		BlacklistChecks: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "tip_blacklist_checks_total",
			Help: "Access token revocation lookups by result (ok, revoked, error).",
		}, []string{"result"}),
		TokenRefresh: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "tip_token_refresh_total",
			Help: "Refresh token exchanges by result.",
		}, []string{"result"}),
		Logins: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "tip_logins_total",
			Help: "Login attempts by result.",
		}, []string{"result"}),
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "tip_http_requests_total",
			Help: "HTTP requests by route pattern, method and status.",
		}, []string{"route", "method", "status"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "tip_http_request_duration_seconds",
			Help:    "HTTP request latency by route pattern and method.",
			Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
		}, []string{"route", "method"}),
		inFlight: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "tip_http_in_flight",
			Help: "HTTP requests currently being served.",
		}),
	}
	build := prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tip_build_info",
		Help: "Build information; the value is always 1.",
	}, []string{"version", "commit"})
	build.WithLabelValues(version, commit).Set(1)

	m.Registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		build, m.LogDropped, m.RedisUp, m.BlacklistChecks, m.TokenRefresh, m.Logins, m.requests, m.duration, m.inFlight,
	)
	return m
}

// Middleware records request metrics labelled by the chi route pattern. Install it with
// router.Use so the pattern is resolved by the time the handler returns.
func (m *Metrics) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.inFlight.Inc()
		defer m.inFlight.Dec()

		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		start := time.Now()
		next.ServeHTTP(ww, r)

		route := unmatchedRoute
		if rc := chi.RouteContext(r.Context()); rc != nil {
			if p := rc.RoutePattern(); p != "" {
				route = p
			}
		}
		status := ww.Status()
		if status == 0 {
			status = http.StatusOK
		}
		m.requests.WithLabelValues(route, r.Method, strconv.Itoa(status)).Inc()
		m.duration.WithLabelValues(route, r.Method).Observe(time.Since(start).Seconds())
	})
}

// RegisterDB exposes database/sql pool statistics as tip_db_* metrics.
func (m *Metrics) RegisterDB(db *sql.DB) { m.Registry.MustRegister(newDBCollector(db)) }

// NewInternalServer builds the internal HTTP server with /metrics and /debug/pprof/*.
// It must only be reachable from the internal network.
func (m *Metrics) NewInternalServer(addr string) *http.Server {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", promhttp.HandlerFor(m.Registry, promhttp.HandlerOpts{}))
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	return &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
}

type dbCollector struct {
	db                                         *sql.DB
	open, inUse, idle, maxOpen                 *prometheus.Desc
	waitCount, waitSeconds, idleClosed, ltClos *prometheus.Desc
}

func newDBCollector(db *sql.DB) *dbCollector {
	d := func(name, help string) *prometheus.Desc { return prometheus.NewDesc("tip_db_"+name, help, nil, nil) }
	return &dbCollector{
		db:          db,
		open:        d("open_connections", "Open connections, in use and idle."),
		inUse:       d("in_use", "Connections currently in use."),
		idle:        d("idle", "Idle connections."),
		maxOpen:     d("max_open_connections", "Configured maximum of open connections."),
		waitCount:   d("wait_count_total", "Total number of waits for a connection."),
		waitSeconds: d("wait_seconds_total", "Total time blocked waiting for a connection."),
		idleClosed:  d("max_idle_closed_total", "Connections closed because of the idle limit."),
		ltClos:      d("max_lifetime_closed_total", "Connections closed because of the lifetime limit."),
	}
}

func (c *dbCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range []*prometheus.Desc{c.open, c.inUse, c.idle, c.maxOpen, c.waitCount, c.waitSeconds, c.idleClosed, c.ltClos} {
		ch <- d
	}
}

func (c *dbCollector) Collect(ch chan<- prometheus.Metric) {
	s := c.db.Stats()
	gauge, counter := prometheus.GaugeValue, prometheus.CounterValue
	ch <- prometheus.MustNewConstMetric(c.open, gauge, float64(s.OpenConnections))
	ch <- prometheus.MustNewConstMetric(c.inUse, gauge, float64(s.InUse))
	ch <- prometheus.MustNewConstMetric(c.idle, gauge, float64(s.Idle))
	ch <- prometheus.MustNewConstMetric(c.maxOpen, gauge, float64(s.MaxOpenConnections))
	ch <- prometheus.MustNewConstMetric(c.waitCount, counter, float64(s.WaitCount))
	ch <- prometheus.MustNewConstMetric(c.waitSeconds, counter, s.WaitDuration.Seconds())
	ch <- prometheus.MustNewConstMetric(c.idleClosed, counter, float64(s.MaxIdleClosed+s.MaxIdleTimeClosed))
	ch <- prometheus.MustNewConstMetric(c.ltClos, counter, float64(s.MaxLifetimeClosed))
}
