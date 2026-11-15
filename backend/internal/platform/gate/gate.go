// Package gate serializes memory-hungry work (image decoding, XLSX parsing). The production
// container has a small memory limit, so two such jobs must never hold their large buffers at
// the same time; later callers wait briefly and then get a retryable error instead of piling up.
package gate

import (
	"context"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

const (
	// maxWait is how long a caller queues for the gate: longer than one typical job (well under
	// a second), short enough that waiting requests do not accumulate behind a stream of uploads.
	maxWait = 5 * time.Second
	// retryAfter is the hint sent to the client when the wait ran out.
	retryAfter = 3 * time.Second
)

// Gate admits one holder at a time.
type Gate struct {
	slot chan struct{}
	wait time.Duration
}

// Heavy is the process-wide gate shared by every memory-hungry parser.
var Heavy = New(maxWait)

// New returns a gate whose waiters give up after wait.
func New(wait time.Duration) *Gate {
	return &Gate{slot: make(chan struct{}, 1), wait: wait}
}

// Acquire blocks until the gate is free, ctx ends or the wait limit passes. On success the
// caller must call the returned release exactly once. A timeout yields a rate-limited domain
// error (HTTP 429 with Retry-After); a finished ctx yields ctx.Err().
func (g *Gate) Acquire(ctx context.Context) (release func(), err error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	release = func() { <-g.slot }
	select {
	case g.slot <- struct{}{}:
		return release, nil
	default:
	}
	t := time.NewTimer(g.wait)
	defer t.Stop()
	select {
	case g.slot <- struct{}{}:
		return release, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-t.C:
		return nil, domain.NewRateLimited(retryAfter)
	}
}
