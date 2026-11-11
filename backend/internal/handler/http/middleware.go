package http

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"runtime/debug"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/rs/zerolog"

	"github.com/pavel-cpp/tip_website/backend/internal/platform/logging"
)

const requestIDHeader = "X-Request-Id"

// defaultCSP is the strict policy for the SPA and the API. /api/docs gets its own relaxed
// policy when Swagger UI is mounted.
const defaultCSP = "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'"

type requestIDKey struct{}

// RequestID returns the request id stored by the RequestID middleware.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// validRequestID accepts short ids made of safe characters only, so an incoming value can
// be echoed in headers and logs without enabling log or header injection.
func validRequestID(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, c := range s {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_', c == '.':
		default:
			return false
		}
	}
	return true
}

// requestIDMiddleware accepts an incoming X-Request-Id or generates one, echoes it in the
// response and stores a request-scoped logger carrying it in the context.
func requestIDMiddleware(newID func() string, base zerolog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := r.Header.Get(requestIDHeader)
			if !validRequestID(id) {
				id = newID()
			}
			w.Header().Set(requestIDHeader, id)
			ctx := context.WithValue(r.Context(), requestIDKey{}, id)
			ctx = logging.WithLogger(ctx, base.With().Str(logging.FieldRequestID, id).Logger())
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// recoverMiddleware turns a panic into a logged ERROR and a generic 500 envelope.
func recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			p := recover()
			if p == nil {
				return
			}
			if p == http.ErrAbortHandler { //nolint:errorlint // sentinel panic value, compared by identity on purpose
				panic(p)
			}
			l := logging.FromContext(r.Context())
			l.Error().Interface("panic", p).Bytes(logging.FieldStack, debug.Stack()).Msg("panic recovered")
			writeError(w, http.StatusInternalServerError, codeInternal, "internal server error", nil)
		}()
		next.ServeHTTP(w, r)
	})
}

// isProbe reports whether the path is a liveness/readiness probe, which is too noisy for INFO.
func isProbe(path string) bool { return path == "/healthz" || path == "/readyz" }

// accessActor carries the authenticated user from the authentication middleware, which runs
// deeper in the chain, back to the access log.
type accessActor struct{ userID, role string }

type accessActorKey struct{}

// noteAccessActor records who made the request for the access log line. It follows the
// authentication middleware.
func noteAccessActor(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a, ok := ActorFrom(r.Context()); ok {
			if h, ok := r.Context().Value(accessActorKey{}).(*accessActor); ok {
				h.userID = a.UserID
				if len(a.Roles) > 0 {
					h.role = strings.Join(a.Roles, ",")
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// accessLogMiddleware writes one line per request using the route pattern, never the raw path.
func accessLogMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		start := time.Now()
		who := &accessActor{}
		next.ServeHTTP(ww, r.WithContext(context.WithValue(r.Context(), accessActorKey{}, who)))

		route := "unmatched"
		if rc := chi.RouteContext(r.Context()); rc != nil && rc.RoutePattern() != "" {
			route = rc.RoutePattern()
		}
		status := ww.Status()
		if status == 0 {
			status = http.StatusOK
		}
		l := logging.FromContext(r.Context())
		ev := l.Info()
		if isProbe(r.URL.Path) {
			ev = l.Debug()
		}
		ev.Str(logging.FieldMethod, r.Method).
			Str(logging.FieldRoute, route).
			Int(logging.FieldStatus, status).
			Int64(logging.FieldDurMS, time.Since(start).Milliseconds()).
			Int(logging.FieldBytes, ww.BytesWritten()).
			Str(logging.FieldIP, clientIP(r))
		if who.userID != "" {
			ev = ev.Str(logging.FieldUserID, who.userID).Str(logging.FieldRole, who.role)
		}
		ev.Msg("http")
	})
}

// clientIP returns the address of the real client. The app is reachable only through our own proxy
// (Caddy on the Docker network, which replaces any client-sent X-Forwarded-For with the remote address it saw),
// so X-Forwarded-For is honoured only when the peer is a loopback or private address, and read right to left:
// the first address that is not one of our own hops is the client. Anything the client prepends to the header is therefore ignored, and a malformed
// header falls back to the peer instead of guessing.
func clientIP(r *http.Request) string {
	peer := r.RemoteAddr
	if host, _, err := net.SplitHostPort(peer); err == nil {
		peer = host
	}
	peer = strings.TrimSpace(peer)
	if a, err := netip.ParseAddr(peer); err != nil || !ownHop(a) {
		return peer
	}
	parts := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
	for _, part := range slices.Backward(parts) {
		a, err := netip.ParseAddr(strings.TrimSpace(part))
		if err != nil {
			return peer
		}
		if !ownHop(a) {
			return a.Unmap().String()
		}
	}
	return peer
}

// ownHop reports whether an address belongs to our own proxy chain rather than to a client.
func ownHop(a netip.Addr) bool {
	a = a.Unmap()
	return a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast()
}

// securityHeaders sets the baseline response headers with the given Content-Security-Policy.
func securityHeaders(csp string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("Content-Security-Policy", csp)
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
			next.ServeHTTP(w, r)
		})
	}
}
