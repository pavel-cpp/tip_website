package http

// Wiring (done by the lead): embed ClientErrorsHandler (built with NewClientErrorsHandler)
// in the handler struct that implements gen.ServerInterface; it provides ReportClientError
// (POST /api/v1/client-errors, public). Pass clock.System{}.Now as now; the limiter owns no
// goroutines, so there is nothing to close.

import (
	"net/http"
	"net/url"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/logging"
)

const (
	clientErrorMaxBody      = 8 << 10
	clientErrorMaxMessage   = 2000
	clientErrorMaxStack     = 4000
	clientErrorMaxURL       = 1000
	clientErrorMaxUA        = 500
	clientErrorMaxRelease   = 64
	clientErrorRatePerMin   = 20
	clientErrorLimiterCap   = 10000
	clientErrorLimiterEvery = time.Minute
)

// ClientErrorsHandler implements the public frontend error sink.
type ClientErrorsHandler struct {
	limiter *clientErrorLimiter
}

// NewClientErrorsHandler builds the handler; now is the clock used by the per-IP limiter.
func NewClientErrorsHandler(now func() time.Time) *ClientErrorsHandler {
	return &ClientErrorsHandler{limiter: newClientErrorLimiter(clientErrorRatePerMin, clientErrorLimiterEvery, now)}
}

// ReportClientError handles POST /client-errors: it validates the report and writes it to
// the structured log stream with source=browser. Nothing is stored.
func (h *ClientErrorsHandler) ReportClientError(w http.ResponseWriter, r *http.Request) {
	if ok, retry := h.limiter.allow(clientIP(r)); !ok {
		fail(w, r, domain.NewRateLimited(retry))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, clientErrorMaxBody)
	var in gen.ClientError
	if err := decodeJSON(w, r, &in); err != nil {
		fail(w, r, err)
		return
	}
	if err := validateClientError(in); err != nil {
		fail(w, r, err)
		return
	}

	l := logging.FromContext(r.Context())
	ev := l.Warn().
		Str(logging.FieldSource, "browser").
		Str("message", in.Message)
	if in.Stack != nil {
		ev = ev.Str(logging.FieldStack, *in.Stack)
	}
	if in.Url != nil {
		// Query strings and fragments can carry tokens or search terms; log the path only.
		ev = ev.Str("url", clientErrorSafeURL(*in.Url))
	}
	if in.Ua != nil {
		ev = ev.Str("ua", *in.Ua)
	}
	if in.Release != nil {
		ev = ev.Str("release", *in.Release)
	}
	ev.Msg("client error")
	w.WriteHeader(http.StatusNoContent)
}

func validateClientError(in gen.ClientError) error {
	var fields []domain.FieldError
	check := func(name, v string, limit int, required bool) {
		switch {
		case required && v == "":
			fields = append(fields, domain.FieldError{Field: name, Reason: "is required"})
		case utf8.RuneCountInString(v) > limit:
			fields = append(fields, domain.FieldError{Field: name, Reason: "is too long"})
		}
	}
	check("message", in.Message, clientErrorMaxMessage, true)
	for _, f := range []struct {
		name  string
		v     *string
		limit int
	}{
		{"stack", in.Stack, clientErrorMaxStack},
		{"url", in.Url, clientErrorMaxURL},
		{"ua", in.Ua, clientErrorMaxUA},
		{"release", in.Release, clientErrorMaxRelease},
	} {
		if f.v != nil {
			check(f.name, *f.v, f.limit, false)
		}
	}
	if len(fields) > 0 {
		return domain.NewValidation(fields...)
	}
	return nil
}

// clientErrorSafeURL reduces a page URL to scheme, host and path.
func clientErrorSafeURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	u.RawQuery, u.Fragment, u.User = "", "", nil
	return u.String()
}

// clientErrorLimiter is a fixed-window per-key counter. The map is bounded: when it is full
// and no entry has expired, new keys are refused rather than growing memory.
type clientErrorLimiter struct {
	limit  int
	window time.Duration
	now    func() time.Time

	mu      sync.Mutex
	entries map[string]*clientErrorWindow
}

type clientErrorWindow struct {
	start time.Time
	count int
}

func newClientErrorLimiter(limit int, window time.Duration, now func() time.Time) *clientErrorLimiter {
	return &clientErrorLimiter{limit: limit, window: window, now: now, entries: make(map[string]*clientErrorWindow)}
}

// allow records a hit for key and reports whether it fits the budget; when it does not, it
// also returns how long until the window resets.
func (l *clientErrorLimiter) allow(key string) (bool, time.Duration) {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()

	e, ok := l.entries[key]
	if ok && now.Sub(e.start) >= l.window {
		ok = false
	}
	if !ok {
		if len(l.entries) >= clientErrorLimiterCap {
			l.sweep(now)
			if len(l.entries) >= clientErrorLimiterCap {
				return false, l.window
			}
		}
		l.entries[key] = &clientErrorWindow{start: now, count: 1}
		return true, 0
	}
	if e.count >= l.limit {
		return false, e.start.Add(l.window).Sub(now)
	}
	e.count++
	return true, 0
}

func (l *clientErrorLimiter) sweep(now time.Time) {
	for k, e := range l.entries {
		if now.Sub(e.start) >= l.window {
			delete(l.entries, k)
		}
	}
}
