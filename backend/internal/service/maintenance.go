package service

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"sync"
	"time"
)

// ErrJobPanic wraps a panic raised by a maintenance job.
var ErrJobPanic = errors.New("maintenance job panicked")

// Job is a named periodic task, for example audit retention or blob garbage collection.
type Job struct {
	Name string
	// Interval is the period between runs; it must be positive.
	Interval time.Duration
	// RunOnStart additionally runs the job once as soon as the scheduler starts.
	RunOnStart bool
	Run        func(ctx context.Context) error
}

// JobResult describes one finished run. The scheduler never logs (services do not log), so
// the caller supplies an observer that does.
type JobResult struct {
	Name     string
	Duration time.Duration
	// Err is nil on success; a panic is reported as an error wrapping ErrJobPanic.
	Err error
}

// Ticker is the subset of time.Ticker the scheduler needs; tests inject a manual one.
type Ticker interface {
	C() <-chan time.Time
	Stop()
}

// NewTicker creates a Ticker firing every d.
type NewTicker func(d time.Duration) Ticker

// SystemTicker is the production NewTicker backed by time.Ticker.
func SystemTicker(d time.Duration) Ticker { return sysTicker{time.NewTicker(d)} }

type sysTicker struct{ t *time.Ticker }

func (s sysTicker) C() <-chan time.Time { return s.t.C }
func (s sysTicker) Stop()               { s.t.Stop() }

// Scheduler runs jobs on fixed intervals. Every job has its own goroutine, so a slow job
// delays only itself, and a job never overlaps with its own previous run.
type Scheduler struct {
	jobs      []Job
	newTicker NewTicker
	clock     Clock
	observe   func(JobResult)
}

// NewScheduler validates jobs and builds a scheduler. observe may be nil.
func NewScheduler(jobs []Job, newTicker NewTicker, clock Clock, observe func(JobResult)) (*Scheduler, error) {
	seen := make(map[string]bool, len(jobs))
	for _, j := range jobs {
		switch {
		case j.Name == "":
			return nil, errors.New("maintenance job needs a name")
		case seen[j.Name]:
			return nil, fmt.Errorf("duplicate maintenance job %q", j.Name)
		case j.Interval <= 0:
			return nil, fmt.Errorf("maintenance job %q needs a positive interval", j.Name)
		case j.Run == nil:
			return nil, fmt.Errorf("maintenance job %q has no function", j.Name)
		}
		seen[j.Name] = true
	}
	if observe == nil {
		observe = func(JobResult) {}
	}
	return &Scheduler{jobs: jobs, newTicker: newTicker, clock: clock, observe: observe}, nil
}

// Run starts all jobs and blocks until ctx is cancelled and every running job has returned.
func (s *Scheduler) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, j := range s.jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.loop(ctx, j)
		}()
	}
	wg.Wait()
}

func (s *Scheduler) loop(ctx context.Context, j Job) {
	t := s.newTicker(j.Interval)
	defer t.Stop()
	if j.RunOnStart && ctx.Err() == nil {
		s.runOnce(ctx, j)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C():
			if ctx.Err() != nil {
				return
			}
			s.runOnce(ctx, j)
		}
	}
}

// runOnce executes the job, converting a panic into an error so that one bad job cannot take
// the process down or stop the schedule.
func (s *Scheduler) runOnce(ctx context.Context, j Job) {
	start := s.clock.Now()
	err := func() (err error) {
		defer func() {
			if p := recover(); p != nil {
				err = fmt.Errorf("%w: %v\n%s", ErrJobPanic, p, debug.Stack())
			}
		}()
		return j.Run(ctx)
	}()
	s.observe(JobResult{Name: j.Name, Duration: s.clock.Now().Sub(start), Err: err})
}
