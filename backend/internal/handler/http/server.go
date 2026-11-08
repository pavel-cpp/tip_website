package http

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/logging"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/metrics"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

const (
	readyTimeout = 2 * time.Second
	// apiIODeadline bounds reading a request body and writing a response on the REST routes.
	// It is per request instead of a server-wide WriteTimeout, which would also cut uploads,
	// exports and WebSocket connections.
	apiIODeadline = 2 * time.Minute
)

// Check is a named readiness probe, for example the database ping.
type Check struct {
	Name string
	Fn   func(ctx context.Context) error
}

// Deps are the collaborators of the router.
type Deps struct {
	Logger  zerolog.Logger
	Metrics *metrics.Metrics
	// NewID generates request ids when the client sends none.
	NewID func() string
	// Ready lists the checks behind GET /readyz.
	Ready []Check

	// API are the services behind the generated routes; nil mounts none (probe-only router).
	API *APIDeps
	// Auth verifies bearer tokens on the REST routes.
	Auth Authenticator
	// AllowedOrigins mirrors ALLOWED_ORIGINS for the cookie endpoints.
	AllowedOrigins []string
	// WS serves GET /api/v1/projects/{id}/ws; nil mounts nothing.
	WS http.Handler
	// SwaggerEnabled and Spec control GET /api/docs and /api/openapi.yaml.
	SwaggerEnabled bool
	Spec           []byte
	// SPA serves everything no API route claims; nil answers with the JSON 404.
	SPA fs.FS
}

// NewRouter builds the public router: the middleware chain, the probes, the generated REST
// routes behind authentication, the WebSocket route, Swagger and the SPA.
func NewRouter(d Deps) (http.Handler, error) {
	guard, err := CookieOriginGuard(d.AllowedOrigins)
	if err != nil {
		return nil, fmt.Errorf("allowed origins: %w", err)
	}
	r := chi.NewRouter()
	r.Use(requestIDMiddleware(d.NewID, d.Logger))
	r.Use(accessLogMiddleware)
	if d.Metrics != nil {
		r.Use(d.Metrics.Middleware)
	}
	r.Use(securityHeaders(defaultCSP))
	r.Use(recoverMiddleware)
	r.Use(clientIPMiddleware)

	notFound := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, codeNotFound, "resource not found", nil)
	})
	if d.SPA != nil {
		notFound = NewSPAHandler(d.SPA).ServeHTTP
	}
	r.NotFound(notFound)
	r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusMethodNotAllowed, codeMethodNotAllowed, "method not allowed", nil)
	})

	live := func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
	ready := readyHandler(d.Ready)
	r.Get("/healthz", live)
	r.Get("/readyz", ready)

	if d.API != nil {
		api := newAPIHandlers(*d.API, probeAPI{live: live, ready: ready})
		r.Group(func(r chi.Router) {
			r.Use(guard, apiDeadlines, Authn(d.Auth, AuthnConfig{Public: publicRoute}), noteAccessActor, AdminPermGuard)
			gen.HandlerWithOptions(api, gen.ChiServerOptions{
				BaseURL:          apiPrefix,
				BaseRouter:       r,
				ErrorHandlerFunc: paramError,
			})
		})
	}
	if d.WS != nil {
		// Outside the REST group: the socket authenticates by its first frame and must not
		// inherit the request deadlines.
		r.Get(apiPrefix+"/projects/{id}/ws", d.WS.ServeHTTP)
	}

	MountSwagger(r, d.SwaggerEnabled, d.Spec)
	return r, nil
}

// publicRoute extends DefaultPublic with the probe operations of the contract.
func publicRoute(r *http.Request) bool {
	if r.Method == http.MethodGet && (r.URL.Path == apiPrefix+"/healthz" || r.URL.Path == apiPrefix+"/readyz") {
		return true
	}
	return DefaultPublic(r)
}

// paramError reports a malformed path or query parameter in the standard envelope.
func paramError(w http.ResponseWriter, r *http.Request, err error) {
	fail(w, r, domain.NewValidation(domain.FieldError{Field: "request", Reason: err.Error()}))
}

// apiDeadlines gives every REST request its own read and write deadline.
func apiDeadlines(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rc := http.NewResponseController(w)
		dl := time.Now().Add(apiIODeadline)
		// Not every writer supports deadlines (tests); the server-level limits still apply then.
		_ = rc.SetReadDeadline(dl)
		_ = rc.SetWriteDeadline(dl)
		next.ServeHTTP(w, r)
	})
}

// clientIPMiddleware makes the peer address available to services for audit entries.
func clientIPMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(service.WithClientIP(r.Context(), clientIP(r))))
	})
}

func readyHandler(checks []Check) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), readyTimeout)
		defer cancel()
		// The body follows ReadinessResponse of the contract: one ok/fail entry per check.
		results := make(map[string]string, len(checks))
		status, code := "ok", http.StatusOK
		for _, c := range checks {
			results[c.Name] = "ok"
			if err := c.Fn(ctx); err != nil {
				l := logging.FromContext(r.Context())
				l.Warn().Err(err).Str("check", c.Name).Msg("readiness check failed")
				results[c.Name] = "fail"
				status, code = "unavailable", http.StatusServiceUnavailable
			}
		}
		writeJSON(w, code, map[string]any{"status": status, "checks": results})
	}
}

// NewServer wraps handler in an http.Server. There is deliberately no ReadTimeout or
// WriteTimeout: they would also cut slow uploads, exports and hijacked WebSocket
// connections. REST routes get per-request deadlines (apiDeadlines) instead.
func NewServer(addr string, handler http.Handler, errorLog *log.Logger) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ErrorLog:          errorLog,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
}
