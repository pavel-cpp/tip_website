package service

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// manualTicker fires only when the test sends on its channel.
type manualTicker struct {
	ch      chan time.Time
	stopped atomic.Bool
}

func (m *manualTicker) C() <-chan time.Time { return m.ch }
func (m *manualTicker) Stop()               { m.stopped.Store(true) }
func (m *manualTicker) fire()               { m.ch <- time.Time{} }

type tickerFarm struct {
	mu        sync.Mutex
	byDur     map[time.Duration]*manualTicker
	requested chan time.Duration
}

func newTickerFarm() *tickerFarm {
	return &tickerFarm{byDur: map[time.Duration]*manualTicker{}, requested: make(chan time.Duration, 16)}
}

func (f *tickerFarm) New(d time.Duration) Ticker {
	f.mu.Lock()
	defer f.mu.Unlock()
	t := &manualTicker{ch: make(chan time.Time)}
	f.byDur[d] = t
	f.requested <- d
	return t
}

func (f *tickerFarm) get(d time.Duration) *manualTicker {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.byDur[d]
}

const testTimeout = 5 * time.Second

func recv[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(testTimeout):
		t.Fatal("timed out waiting for the scheduler")
		panic("unreachable")
	}
}

func startScheduler(t *testing.T, jobs []Job, farm *tickerFarm) (results chan JobResult, cancel func(), done chan struct{}) {
	t.Helper()
	results = make(chan JobResult, 16)
	s, err := NewScheduler(jobs, farm.New, &fakeClock{sysNow}, func(r JobResult) { results <- r })
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancelCtx := context.WithCancel(context.Background())
	done = make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	for range jobs {
		recv(t, farm.requested) // every job has created its ticker
	}
	t.Cleanup(cancelCtx)
	return results, cancelCtx, done
}

func TestSchedulerRunsJobsOnTheirOwnIntervals(t *testing.T) {
	farm := newTickerFarm()
	var a, b atomic.Int32
	results, cancel, done := startScheduler(t, []Job{
		{Name: "audit", Interval: time.Hour, Run: func(context.Context) error { a.Add(1); return nil }},
		{Name: "gc", Interval: 24 * time.Hour, Run: func(context.Context) error { b.Add(1); return nil }},
	}, farm)

	farm.get(time.Hour).fire()
	if r := recv(t, results); r.Name != "audit" || r.Err != nil {
		t.Fatalf("result = %+v", r)
	}
	farm.get(time.Hour).fire()
	recv(t, results)
	farm.get(24 * time.Hour).fire()
	if r := recv(t, results); r.Name != "gc" {
		t.Fatalf("result = %+v", r)
	}
	if a.Load() != 2 || b.Load() != 1 {
		t.Errorf("runs: audit=%d gc=%d", a.Load(), b.Load())
	}
	cancel()
	recv(t, done)
}

func TestSchedulerReportsErrorsAndKeepsRunning(t *testing.T) {
	farm := newTickerFarm()
	boom := errors.New("boom")
	var n atomic.Int32
	results, cancel, done := startScheduler(t, []Job{{Name: "j", Interval: time.Minute, Run: func(context.Context) error {
		if n.Add(1) == 1 {
			return boom
		}
		return nil
	}}}, farm)

	farm.get(time.Minute).fire()
	if r := recv(t, results); !errors.Is(r.Err, boom) {
		t.Fatalf("first result = %+v", r)
	}
	farm.get(time.Minute).fire()
	if r := recv(t, results); r.Err != nil {
		t.Fatalf("second result = %+v", r)
	}
	cancel()
	recv(t, done)
}

func TestSchedulerRecoversFromPanic(t *testing.T) {
	farm := newTickerFarm()
	var n atomic.Int32
	results, cancel, done := startScheduler(t, []Job{{Name: "p", Interval: time.Minute, Run: func(context.Context) error {
		if n.Add(1) == 1 {
			panic("kaboom")
		}
		return nil
	}}}, farm)

	farm.get(time.Minute).fire()
	r := recv(t, results)
	if !errors.Is(r.Err, ErrJobPanic) {
		t.Fatalf("err = %v, want ErrJobPanic", r.Err)
	}
	farm.get(time.Minute).fire()
	if r := recv(t, results); r.Err != nil {
		t.Fatalf("the schedule must survive a panic: %+v", r)
	}
	cancel()
	recv(t, done)
}

func TestSchedulerRunOnStart(t *testing.T) {
	farm := newTickerFarm()
	results, cancel, done := startScheduler(t, []Job{
		{Name: "now", Interval: time.Hour, RunOnStart: true, Run: func(context.Context) error { return nil }},
		{Name: "later", Interval: 2 * time.Hour, Run: func(context.Context) error { return nil }},
	}, farm)
	if r := recv(t, results); r.Name != "now" {
		t.Fatalf("result = %+v", r)
	}
	select {
	case r := <-results:
		t.Fatalf("unexpected extra run: %+v", r)
	case <-time.After(50 * time.Millisecond):
	}
	cancel()
	recv(t, done)
}

func TestSchedulerStopsOnCancelAndStopsTickers(t *testing.T) {
	farm := newTickerFarm()
	started := make(chan struct{})
	release := make(chan struct{})
	var sawCancel atomic.Bool
	_, cancel, done := startScheduler(t, []Job{{Name: "slow", Interval: time.Minute, Run: func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		sawCancel.Store(true)
		<-release
		return ctx.Err()
	}}}, farm)

	farm.get(time.Minute).fire()
	recv(t, started)
	cancel()
	select {
	case <-done:
		t.Fatal("Run must wait for the running job")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	recv(t, done)
	if !sawCancel.Load() {
		t.Error("the job must receive the cancelled context")
	}
	if !farm.get(time.Minute).stopped.Load() {
		t.Error("tickers must be stopped")
	}
}

func TestSchedulerDoesNotStartAfterCancel(t *testing.T) {
	farm := newTickerFarm()
	var n atomic.Int32
	s, err := NewScheduler([]Job{{Name: "x", Interval: time.Minute, RunOnStart: true, Run: func(context.Context) error { n.Add(1); return nil }}},
		farm.New, &fakeClock{sysNow}, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.Run(ctx)
	if n.Load() != 0 {
		t.Errorf("job ran %d times with a cancelled context", n.Load())
	}
}

func TestSchedulerValidation(t *testing.T) {
	ok := func(context.Context) error { return nil }
	bad := map[string][]Job{
		"no name":   {{Interval: time.Second, Run: ok}},
		"duplicate": {{Name: "a", Interval: time.Second, Run: ok}, {Name: "a", Interval: time.Second, Run: ok}},
		"interval":  {{Name: "a", Interval: 0, Run: ok}},
		"no func":   {{Name: "a", Interval: time.Second}},
	}
	for name, jobs := range bad {
		if _, err := NewScheduler(jobs, SystemTicker, &fakeClock{sysNow}, nil); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestSchedulerMeasuresDurationWithInjectedClock(t *testing.T) {
	farm := newTickerFarm()
	clk := &fakeClock{sysNow}
	results := make(chan JobResult, 1)
	s, err := NewScheduler([]Job{{Name: "d", Interval: time.Minute, Run: func(context.Context) error {
		clk.t = clk.t.Add(3 * time.Second)
		return nil
	}}}, farm.New, clk, func(r JobResult) { results <- r })
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	recv(t, farm.requested)
	farm.get(time.Minute).fire()
	if r := recv(t, results); r.Duration != 3*time.Second {
		t.Errorf("duration = %v", r.Duration)
	}
}

func TestSystemTickerFires(t *testing.T) {
	tk := SystemTicker(5 * time.Millisecond)
	defer tk.Stop()
	select {
	case <-tk.C():
	case <-time.After(testTimeout):
		t.Fatal("system ticker never fired")
	}
}
