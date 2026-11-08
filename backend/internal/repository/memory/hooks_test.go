package memory

import (
	"sync/atomic"
	"testing"
)

type limitMetrics struct {
	NopMetrics
	limited atomic.Int32
}

func (m *limitMetrics) RateLimited() { m.limited.Add(1) }

func TestRateLimitedIsReported(t *testing.T) {
	met := &limitMetrics{}
	h := newHarness(t, func(c *Config) { c.Metrics = met })
	a := h.join("p1", "alice")
	for i := 0; i < 20; i++ {
		if !a.Allow() {
			t.Fatalf("message %d must be allowed", i)
		}
	}
	if met.limited.Load() != 0 {
		t.Fatal("allowed frames must not be counted")
	}
	a.Allow()
	a.Allow()
	if got := met.limited.Load(); got != 2 {
		t.Fatalf("rate limited = %d, want 2", got)
	}
}

func TestActiveLocks(t *testing.T) {
	h := newHarness(t, nil)
	a := h.join("p1", "alice")
	if h.hub.ActiveLocks() != 0 {
		t.Fatal("no locks expected")
	}
	for _, row := range []string{"r1", "r2"} {
		if _, err := a.Acquire(row); err != nil {
			t.Fatal(err)
		}
	}
	if got := h.hub.ActiveLocks(); got != 2 {
		t.Fatalf("active locks = %d, want 2", got)
	}
	a.Release("r1")
	eventually(t, func() bool { return h.hub.ActiveLocks() == 1 }, "released lock leaves the index")
	a.Leave()
	eventually(t, func() bool { return h.hub.ActiveLocks() == 0 }, "locks dropped when the holder leaves")
}
