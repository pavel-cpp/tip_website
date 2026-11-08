package service

import (
	"context"
	"path/filepath"
	"sync"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

const (
	checkTimeout       = 2 * time.Second
	uploadsSizeTTL     = time.Minute
	uploadsSubdirName  = "uploads"
	secondsPerDuration = time.Second
)

// SystemConfig carries the static facts shown on the system page.
type SystemConfig struct {
	Version string
	// DataDir is the volume the disk figures refer to; uploads live in DataDir/uploads.
	DataDir            string
	ObsRetentionDays   int
	AuditRetentionDays int
}

// PoolStats are database connection pool counters.
type PoolStats struct {
	Open, InUse, Idle, MaxOpen int
}

// SystemStatus is the admin system snapshot.
type SystemStatus struct {
	Version      string
	Uptime       time.Duration
	DBSizeBytes  int64
	Pool         PoolStats
	DiskFree     int64
	DiskTotal    int64
	UploadsBytes int64
	ObsDays      int
	AuditDays    int
	Checks       []NamedCheckResult
}

// SystemService assembles the system status from probes and health checks.
type SystemService struct {
	cfg     SystemConfig
	clock   Clock
	started time.Time
	host    HostProbe
	db      DatabaseProbe
	checks  []HealthCheck

	mu          sync.Mutex
	uploadsSize int64
	uploadsAt   time.Time
}

// NewSystemService builds the service; started is the process start time. Checks are
// reported in the given order.
func NewSystemService(cfg SystemConfig, clock Clock, started time.Time, host HostProbe, db DatabaseProbe, checks ...HealthCheck) *SystemService {
	return &SystemService{cfg: cfg, clock: clock, started: started, host: host, db: db, checks: checks}
}

// Status returns the current system state. It requires system.view. Individual probe
// failures degrade to zero values instead of failing the page: an operator opening the
// status page during an incident must still see the other figures and the failing check.
func (s *SystemService) Status(ctx context.Context, actor domain.Actor) (SystemStatus, error) {
	if err := actor.Require(domain.PermSystemView); err != nil {
		return SystemStatus{}, err
	}
	st := SystemStatus{
		Version:   s.cfg.Version,
		Uptime:    max(s.clock.Now().Sub(s.started), 0).Truncate(secondsPerDuration),
		ObsDays:   s.cfg.ObsRetentionDays,
		AuditDays: s.cfg.AuditRetentionDays,
	}
	st.Pool.Open, st.Pool.InUse, st.Pool.Idle, st.Pool.MaxOpen = s.db.Pool()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		dctx, cancel := context.WithTimeout(ctx, checkTimeout)
		defer cancel()
		if n, err := s.db.Size(dctx); err == nil {
			st.DBSizeBytes = n
		}
	}()

	if free, total, err := s.host.DiskUsage(s.cfg.DataDir); err == nil {
		st.DiskFree, st.DiskTotal = clampInt64(free), clampInt64(total)
	}
	st.UploadsBytes = s.uploadsBytes(ctx)
	st.Checks = s.runChecks(ctx)
	wg.Wait()
	return st, nil
}

// runChecks runs all checks concurrently, each under its own timeout, keeping their order.
func (s *SystemService) runChecks(ctx context.Context) []NamedCheckResult {
	out := make([]NamedCheckResult, len(s.checks))
	var wg sync.WaitGroup
	for i, c := range s.checks {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, checkTimeout)
			defer cancel()
			out[i] = NamedCheckResult{Name: c.Name(), CheckResult: c.Check(cctx)}
		}()
	}
	wg.Wait()
	return out
}

// uploadsBytes caches the directory walk: a large uploads tree must not be re-scanned on
// every refresh of the status page.
func (s *SystemService) uploadsBytes(ctx context.Context) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock.Now()
	if !s.uploadsAt.IsZero() && now.Sub(s.uploadsAt) < uploadsSizeTTL {
		return s.uploadsSize
	}
	n, err := s.host.DirSize(ctx, filepath.Join(s.cfg.DataDir, uploadsSubdirName))
	if err != nil {
		return s.uploadsSize
	}
	s.uploadsSize, s.uploadsAt = n, now
	return n
}

func clampInt64(v uint64) int64 {
	const maxInt64 = 1<<63 - 1
	if v > maxInt64 {
		return maxInt64
	}
	return int64(v)
}
