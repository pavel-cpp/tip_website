package service

import (
	"context"
)

// HostProbe reads facts about the machine the process runs on. Implemented by
// platform/sysinfo.Host.
type HostProbe interface {
	// DiskUsage reports free and total bytes of the volume holding path.
	DiskUsage(path string) (free, total uint64, err error)
	// DirSize sums the sizes of all files below root; a missing root counts as empty.
	DirSize(ctx context.Context, root string) (int64, error)
	// ReadBackupMetrics returns the Prometheus textfile written by the backup container.
	// The error must wrap fs.ErrNotExist when the file is absent.
	ReadBackupMetrics(ctx context.Context) ([]byte, error)
}

// DatabaseProbe reads database statistics. Implemented by platform/sysinfo.Database.
type DatabaseProbe interface {
	// Size returns the on-disk size of the database in bytes.
	Size(ctx context.Context) (int64, error)
	// Pool returns the connection pool counters.
	Pool() (open, inUse, idle, maxOpen int)
}

// CheckStatus is the outcome of a health check.
type CheckStatus string

// Health check outcomes, ordered by severity.
const (
	CheckOK   CheckStatus = "ok"
	CheckWarn CheckStatus = "warn"
	CheckFail CheckStatus = "fail"
)

// CheckResult is what one health check reports.
type CheckResult struct {
	Status CheckStatus
	// Detail is a short human-readable explanation; it must not contain secrets.
	Detail string
}

// HealthCheck is a named probe shown on the admin system page. Checks are interfaces so
// tests use fakes.
type HealthCheck interface {
	Name() string
	Check(ctx context.Context) CheckResult
}
