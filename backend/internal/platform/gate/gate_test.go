package gate

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

func TestAcquire(t *testing.T) {
	g := New(30 * time.Millisecond)
	rel, err := g.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name string
		ctx  func() (context.Context, context.CancelFunc)
		want func(error) bool
	}{
		{"wait limit", func() (context.Context, context.CancelFunc) { return context.WithCancel(context.Background()) },
			func(err error) bool { return errors.Is(err, domain.ErrRateLimited) }},
		{"context ends first", func() (context.Context, context.CancelFunc) {
			return context.WithTimeout(context.Background(), time.Millisecond)
		}, func(err error) bool { return errors.Is(err, context.DeadlineExceeded) }},
		{"context already done", func() (context.Context, context.CancelFunc) {
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			return ctx, cancel
		}, func(err error) bool { return errors.Is(err, context.Canceled) }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := tc.ctx()
			defer cancel()
			if _, err := g.Acquire(ctx); !tc.want(err) {
				t.Fatalf("got %v", err)
			}
		})
	}

	rel()
	rel2, err := g.Acquire(context.Background())
	if err != nil {
		t.Fatalf("gate not released: %v", err)
	}
	rel2()
}
