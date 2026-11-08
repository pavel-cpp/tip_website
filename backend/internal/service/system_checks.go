package service

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"strconv"
	"strings"
	"time"
)

const (
	// diskWarnBytes is the free-space level below which the disk check warns even when the
	// configured MIN_FREE_DISK_MB hard limit has not been reached.
	diskWarnBytes = 1536 << 20
	// backupMaxAge is how stale a successful backup may be before the check warns.
	backupMaxAge       = 36 * time.Hour
	backupMetricName   = "backup_last_success_timestamp"
	megabyte           = 1 << 20
	bytesPerGigabyte   = 1 << 30
	backupMetricTarget = "target"
)

// pingCheck reports a dependency that answers a ping function.
type pingCheck struct {
	name   string
	onFail CheckStatus
	ping   func(ctx context.Context) error
}

// NewPingCheck builds a check that is ok when ping succeeds and reports onFail otherwise
// (for example CheckFail for Postgres, CheckWarn for Redis in fail-open mode). The error text
// is deliberately not exposed: it may contain connection details.
func NewPingCheck(name string, onFail CheckStatus, ping func(ctx context.Context) error) HealthCheck {
	return pingCheck{name: name, onFail: onFail, ping: ping}
}

func (c pingCheck) Name() string { return c.name }

func (c pingCheck) Check(ctx context.Context) CheckResult {
	if err := c.ping(ctx); err != nil {
		return CheckResult{Status: c.onFail, Detail: "unreachable"}
	}
	return CheckResult{Status: CheckOK, Detail: "reachable"}
}

type diskCheck struct {
	host      HostProbe
	path      string
	minFreeMB int
}

// NewDiskCheck fails below minFreeMB of free space (uploads are rejected there) and warns
// below 1.5 GB.
func NewDiskCheck(host HostProbe, path string, minFreeMB int) HealthCheck {
	return diskCheck{host: host, path: path, minFreeMB: minFreeMB}
}

func (diskCheck) Name() string { return "disk" }

func (c diskCheck) Check(context.Context) CheckResult {
	free, total, err := c.host.DiskUsage(c.path)
	if err != nil {
		return CheckResult{Status: CheckFail, Detail: "disk usage unavailable"}
	}
	detail := fmt.Sprintf("%s free of %s", formatBytes(free), formatBytes(total))
	switch {
	case free < uint64(c.minFreeMB)*megabyte: //nolint:gosec // a validated positive config value
		return CheckResult{Status: CheckFail, Detail: detail + ", below the minimum of " + strconv.Itoa(c.minFreeMB) + " MB"}
	case free < diskWarnBytes:
		return CheckResult{Status: CheckWarn, Detail: detail + ", below 1.5 GB"}
	}
	return CheckResult{Status: CheckOK, Detail: detail}
}

type backupCheck struct {
	host  HostProbe
	clock Clock
}

// NewBackupCheck reads the backup container's Prometheus textfile and warns when a target
// has no recent success (older than 36 hours) or when the file is missing. It never fails:
// a missing backup is something to look at, not a reason to mark the app broken.
func NewBackupCheck(host HostProbe, clock Clock) HealthCheck {
	return backupCheck{host: host, clock: clock}
}

func (backupCheck) Name() string { return "backups" }

func (c backupCheck) Check(ctx context.Context) CheckResult {
	raw, err := c.host.ReadBackupMetrics(ctx)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return CheckResult{Status: CheckWarn, Detail: "no backup metrics file yet"}
		}
		return CheckResult{Status: CheckWarn, Detail: "backup metrics unreadable"}
	}
	stamps := parseBackupTimestamps(string(raw))
	now := c.clock.Now()
	status := CheckOK
	parts := make([]string, 0, 2)
	for _, target := range []string{"local", "offsite"} {
		ts, ok := stamps[target]
		switch {
		case !ok:
			status = CheckWarn
			parts = append(parts, target+": no record")
		case now.Sub(ts) > backupMaxAge:
			status = CheckWarn
			parts = append(parts, target+": "+formatAge(now.Sub(ts))+" ago, too old")
		default:
			parts = append(parts, target+": "+formatAge(now.Sub(ts))+" ago")
		}
	}
	return CheckResult{Status: status, Detail: strings.Join(parts, "; ")}
}

// parseBackupTimestamps extracts backup_last_success_timestamp{target="..."} samples from
// Prometheus text exposition format. Unrelated and malformed lines are ignored.
func parseBackupTimestamps(text string) map[string]time.Time {
	out := make(map[string]time.Time)
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, backupMetricName+"{") {
			continue
		}
		end := strings.IndexByte(line, '}')
		if end < 0 {
			continue
		}
		labels, value := line[len(backupMetricName)+1:end], strings.Fields(line[end+1:])
		if len(value) == 0 {
			continue
		}
		target := labelValue(labels, backupMetricTarget)
		secs, err := strconv.ParseFloat(value[0], 64)
		if target == "" || err != nil || secs <= 0 {
			continue
		}
		out[target] = time.Unix(int64(secs), 0)
	}
	return out
}

// labelValue returns the value of a key="value" pair inside a Prometheus label set.
func labelValue(labels, key string) string {
	for _, pair := range strings.Split(labels, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(pair), "=")
		if ok && k == key {
			return strings.Trim(v, `"`)
		}
	}
	return ""
}

func formatAge(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	if d < time.Hour {
		return strconv.Itoa(int(d.Minutes())) + " min"
	}
	return strconv.Itoa(int(d.Hours())) + " h"
}

func formatBytes(n uint64) string {
	return strconv.FormatFloat(float64(n)/bytesPerGigabyte, 'f', 1, 64) + " GB"
}

// NamedCheckResult is a check outcome together with the check name.
type NamedCheckResult struct {
	Name string
	CheckResult
}
