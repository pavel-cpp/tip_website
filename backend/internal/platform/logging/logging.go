// Package logging provides the process-wide zerolog logger: JSON output, non-blocking
// writes, request-scoped loggers in context and adapters for third-party code.
package logging

import (
	"context"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/diode"
)

const (
	ringSize      = 8192
	flushInterval = 10 * time.Millisecond
)

func init() {
	zerolog.TimeFieldFormat = "2006-01-02T15:04:05.000Z07:00"
	zerolog.TimestampFieldName = FieldTime
	zerolog.MessageFieldName = FieldMessage
	zerolog.TimestampFunc = func() time.Time { return time.Now().UTC() }
}

// Options configures New.
type Options struct {
	// Level is one of debug, info, warn, error; unknown values fall back to info.
	Level string
	// Out is the destination; os.Stdout when nil.
	Out io.Writer
	// OnDropped is called with the number of events dropped by the non-blocking buffer.
	OnDropped func(n int)
}

// New builds a JSON logger that writes through a ring buffer, so a slow stdout never
// blocks request handling. Call the returned close function on shutdown to flush it.
func New(o Options) (zerolog.Logger, func() error) {
	out := o.Out
	if out == nil {
		out = os.Stdout
	}
	dw := diode.NewWriter(out, ringSize, flushInterval, func(missed int) {
		if o.OnDropped != nil {
			o.OnDropped(missed)
		}
	})
	l := zerolog.New(dw).Level(parseLevel(o.Level)).With().Timestamp().Logger()
	return l, dw.Close
}

func parseLevel(s string) zerolog.Level {
	switch strings.ToLower(s) {
	case "debug":
		return zerolog.DebugLevel
	case "warn":
		return zerolog.WarnLevel
	case "error":
		return zerolog.ErrorLevel
	default:
		return zerolog.InfoLevel
	}
}

type ctxKey struct{}

// WithLogger returns a context carrying l.
func WithLogger(ctx context.Context, l zerolog.Logger) context.Context {
	return context.WithValue(ctx, ctxKey{}, l)
}

// FromContext returns the logger stored in ctx, or a disabled logger when there is none.
func FromContext(ctx context.Context) zerolog.Logger {
	if l, ok := ctx.Value(ctxKey{}).(zerolog.Logger); ok {
		return l
	}
	return zerolog.Nop()
}

// WarnSampler throttles repetitive WARN events: the first Burst events per Period pass,
// afterwards every Nth one does and is marked with the "sampled" field. ERROR events must
// never go through it.
type WarnSampler struct {
	Burst  int
	Period time.Duration
	Every  int

	mu      sync.Mutex
	start   time.Time
	count   int
	skipped int
	now     func() time.Time
}

// NewWarnSampler returns the documented default: 5 per second, then every 10th.
func NewWarnSampler() *WarnSampler {
	return &WarnSampler{Burst: 5, Period: time.Second, Every: 10, now: time.Now}
}

// Warn returns a WARN event or nil when the event is sampled out; zerolog events are
// nil-safe, so callers chain on the result without checking.
func (s *WarnSampler) Warn(l *zerolog.Logger) *zerolog.Event {
	s.mu.Lock()
	now := s.now()
	if s.start.IsZero() || now.Sub(s.start) >= s.Period {
		s.start, s.count, s.skipped = now, 0, 0
	}
	s.count++
	if s.count <= s.Burst {
		s.mu.Unlock()
		return l.Warn()
	}
	s.skipped++
	pass := s.skipped%s.Every == 0
	s.mu.Unlock()
	if !pass {
		return nil
	}
	return l.Warn().Bool(FieldSampled, true)
}
