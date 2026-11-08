package db

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// QueryObserver receives the SQL text and duration of every statement. Implementations must
// reduce the text to a bounded category before using it as a metric label and must not keep
// or log it: statements may be built next to personal data.
type QueryObserver func(sql string, d time.Duration)

// Option customizes Open.
type Option func(*options)

type options struct{ observer QueryObserver }

// WithQueryObserver reports every statement run through the pool to obs.
func WithQueryObserver(obs QueryObserver) Option {
	return func(o *options) { o.observer = obs }
}

type startKey struct{}

type startInfo struct {
	sql string
	at  time.Time
}

// queryTracer adapts a QueryObserver to the pgx tracer hook, which sits below database/sql.
type queryTracer struct{ obs QueryObserver }

func (t queryTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, startKey{}, startInfo{sql: d.SQL, at: time.Now()})
}

func (t queryTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if s, ok := ctx.Value(startKey{}).(startInfo); ok {
		t.obs(s.sql, time.Since(s.at))
	}
}
