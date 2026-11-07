package http

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog"

	"github.com/pavel-cpp/tip_website/backend/internal/platform/logging"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/metrics"
)

const readyTimeout = 2 * time.Second

// Check is a named readiness probe, for example the database ping.
type Check struct {
	Name string
	Fn   func(ctx context.Context) error
}

// Deps are the collaborators of the router. Business services are added here later.
type Deps struct {
	Logger  zerolog.Logger
	Metrics *metrics.Metrics
	// NewID generates request ids when the client sends none.
	NewID func() string
	// Ready lists the checks behind GET /readyz.
	Ready []Check
}

// NewRouter builds the public router with the middleware chain and the probe endpoints.
func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(requestIDMiddleware(d.NewID, d.Logger))
	r.Use(accessLogMiddleware)
	if d.Metrics != nil {
		r.Use(d.Metrics.Middleware)
	}
	r.Use(securityHeaders(defaultCSP))
	r.Use(recoverMiddleware)

	r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, codeNotFound, "resource not found", nil)
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusMethodNotAllowed, codeMethodNotAllowed, "method not allowed", nil)
	})

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Get("/readyz", readyHandler(d.Ready))
	return r
}

func readyHandler(checks []Check) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), readyTimeout)
		defer cancel()
		var failed []string
		for _, c := range checks {
			if err := c.Fn(ctx); err != nil {
				l := logging.FromContext(r.Context())
				l.Warn().Err(err).Str("check", c.Name).Msg("readiness check failed")
				failed = append(failed, c.Name)
			}
		}
		if len(failed) > 0 {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "unavailable", "failed": failed})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	}
}

// NewServer wraps handler in an http.Server with conservative timeouts.
func NewServer(addr string, handler http.Handler, errorLog *log.Logger) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ErrorLog:          errorLog,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
}
