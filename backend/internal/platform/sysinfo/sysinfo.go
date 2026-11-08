// Package sysinfo reads host and database facts for the admin system status: disk usage,
// directory sizes, the backup metrics file and database size / pool statistics. The disk
// code is portable (Windows dev machines, Linux production).
package sysinfo

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// maxMetricsFile bounds the backup textfile read; the real file is a few hundred bytes.
const maxMetricsFile = 64 << 10

// Host implements service.HostProbe (structurally; platform may not import service) on the local file system.
type Host struct {
	// BackupMetricsPath is the Prometheus textfile written by the backup container.
	BackupMetricsPath string
}

// DiskUsage reports free (to unprivileged users) and total bytes of the volume holding path.
func (Host) DiskUsage(path string) (free, total uint64, err error) { return diskUsage(path) }

// DirSize sums the sizes of the regular files below root. A missing root counts as empty;
// files that vanish during the walk are skipped.
func (Host) DirSize(ctx context.Context, root string) (int64, error) {
	var total int64
	err := filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if d.Type().IsRegular() {
			info, ierr := d.Info()
			if ierr != nil {
				if errors.Is(ierr, fs.ErrNotExist) {
					return nil
				}
				return ierr
			}
			total += info.Size()
		}
		return nil
	})
	return total, err
}

// ReadBackupMetrics returns the backup Prometheus textfile; the error wraps fs.ErrNotExist
// when the backup container has not written it yet.
func (h Host) ReadBackupMetrics(context.Context) ([]byte, error) {
	f, err := os.Open(h.BackupMetricsPath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return io.ReadAll(io.LimitReader(f, maxMetricsFile))
}

// Database implements service.DatabaseProbe (structurally) on a *sql.DB.
type Database struct {
	DB *sql.DB
}

// Size returns the on-disk size of the current database in bytes.
func (d Database) Size(ctx context.Context) (int64, error) {
	var n int64
	err := d.DB.QueryRowContext(ctx, `SELECT pg_database_size(current_database())`).Scan(&n)
	return n, err
}

// Pool returns the connection pool counters.
func (d Database) Pool() (open, inUse, idle, maxOpen int) {
	s := d.DB.Stats()
	return s.OpenConnections, s.InUse, s.Idle, s.MaxOpenConnections
}
