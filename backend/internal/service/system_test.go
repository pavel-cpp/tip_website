package service

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) Now() time.Time { return c.t }

type fakeHost struct {
	free, total uint64
	diskErr     error
	dirSize     int64
	dirErr      error
	dirCalls    atomic.Int32
	dirRoot     string
	metrics     string
	metricsErr  error
}

func (h *fakeHost) DiskUsage(string) (uint64, uint64, error) { return h.free, h.total, h.diskErr }
func (h *fakeHost) DirSize(_ context.Context, root string) (int64, error) {
	h.dirCalls.Add(1)
	h.dirRoot = root
	return h.dirSize, h.dirErr
}
func (h *fakeHost) ReadBackupMetrics(context.Context) ([]byte, error) {
	return []byte(h.metrics), h.metricsErr
}

type fakeDB struct {
	size    int64
	sizeErr error
}

func (d fakeDB) Size(context.Context) (int64, error) { return d.size, d.sizeErr }
func (fakeDB) Pool() (int, int, int, int)            { return 4, 1, 3, 10 }

type fakeCheck struct {
	name string
	res  CheckResult
}

func (c fakeCheck) Name() string                      { return c.name }
func (c fakeCheck) Check(context.Context) CheckResult { return c.res }

var sysNow = time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

func systemViewer() domain.Actor {
	return domain.Actor{UserID: "u1", Perms: domain.NewPermissionSet(domain.PermSystemView)}
}

func TestSystemStatusRequiresPermission(t *testing.T) {
	s := NewSystemService(SystemConfig{}, &fakeClock{sysNow}, sysNow, &fakeHost{}, fakeDB{})
	_, err := s.Status(context.Background(), domain.Actor{Perms: domain.NewPermissionSet()})
	if !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("err = %v, want forbidden", err)
	}
}

func TestSystemStatusAssembly(t *testing.T) {
	host := &fakeHost{free: 5 << 30, total: 10 << 30, dirSize: 1234}
	clk := &fakeClock{sysNow.Add(90*time.Minute + 700*time.Millisecond)}
	s := NewSystemService(SystemConfig{Version: "1.2.3", DataDir: "/data", ObsRetentionDays: 3, AuditRetentionDays: 30},
		clk, sysNow, host, fakeDB{size: 777},
		fakeCheck{"postgres", CheckResult{CheckOK, "reachable"}},
		fakeCheck{"redis", CheckResult{CheckWarn, "unreachable"}})

	st, err := s.Status(context.Background(), systemViewer())
	if err != nil {
		t.Fatal(err)
	}
	if st.Version != "1.2.3" || st.Uptime != 90*time.Minute || st.DBSizeBytes != 777 {
		t.Errorf("basics wrong: %+v", st)
	}
	if st.Pool != (PoolStats{Open: 4, InUse: 1, Idle: 3, MaxOpen: 10}) {
		t.Errorf("pool = %+v", st.Pool)
	}
	if st.DiskFree != 5<<30 || st.DiskTotal != 10<<30 || st.UploadsBytes != 1234 {
		t.Errorf("disk/uploads wrong: %+v", st)
	}
	if st.ObsDays != 3 || st.AuditDays != 30 {
		t.Errorf("retention wrong: %+v", st)
	}
	if len(st.Checks) != 2 || st.Checks[0].Name != "postgres" || st.Checks[1].Status != CheckWarn {
		t.Errorf("checks = %+v", st.Checks)
	}
	if got := host.dirRoot; got != filepath.Join("/data", "uploads") {
		t.Errorf("uploads root = %q", got)
	}
}

func TestSystemStatusDegradesOnProbeFailure(t *testing.T) {
	host := &fakeHost{diskErr: errors.New("boom"), dirErr: errors.New("boom")}
	s := NewSystemService(SystemConfig{}, &fakeClock{sysNow}, sysNow, host, fakeDB{sizeErr: errors.New("down")})
	st, err := s.Status(context.Background(), systemViewer())
	if err != nil {
		t.Fatalf("probe failures must not fail the page: %v", err)
	}
	if st.DBSizeBytes != 0 || st.DiskTotal != 0 || st.UploadsBytes != 0 {
		t.Errorf("expected zero values: %+v", st)
	}
}

func TestSystemUploadsSizeIsCached(t *testing.T) {
	host := &fakeHost{dirSize: 10}
	clk := &fakeClock{sysNow}
	s := NewSystemService(SystemConfig{}, clk, sysNow, host, fakeDB{})
	for i := 0; i < 3; i++ {
		if _, err := s.Status(context.Background(), systemViewer()); err != nil {
			t.Fatal(err)
		}
	}
	if n := host.dirCalls.Load(); n != 1 {
		t.Fatalf("DirSize calls = %d, want 1 within the TTL", n)
	}
	clk.t = clk.t.Add(2 * time.Minute)
	host.dirSize = 20
	st, _ := s.Status(context.Background(), systemViewer())
	if st.UploadsBytes != 20 || host.dirCalls.Load() != 2 {
		t.Errorf("cache must expire: uploads=%d calls=%d", st.UploadsBytes, host.dirCalls.Load())
	}
}

func TestPingCheck(t *testing.T) {
	ok := NewPingCheck("postgres", CheckFail, func(context.Context) error { return nil })
	if r := ok.Check(context.Background()); ok.Name() != "postgres" || r.Status != CheckOK {
		t.Errorf("ok: %+v", r)
	}
	bad := NewPingCheck("redis", CheckWarn, func(context.Context) error { return errors.New("redis://user:secret@host") })
	r := bad.Check(context.Background())
	if r.Status != CheckWarn {
		t.Errorf("status = %s", r.Status)
	}
	if r.Detail == "" || strings.Contains(r.Detail, "secret") || strings.Contains(r.Detail, "redis://") {
		t.Errorf("detail must not leak the error: %q", r.Detail)
	}
}

func TestDiskCheckThresholds(t *testing.T) {
	cases := []struct {
		name   string
		free   uint64
		err    error
		want   CheckStatus
		minMB  int
		detail string
	}{
		{"plenty", 5 << 30, nil, CheckOK, 1024, ""},
		{"warn below 1.5 GB", 1400 << 20, nil, CheckWarn, 1024, ""},
		{"exactly 1.5 GB is ok", 1536 << 20, nil, CheckOK, 1024, ""},
		{"fail below minimum", 900 << 20, nil, CheckFail, 1024, ""},
		{"minimum above warn level", 2000 << 20, nil, CheckFail, 2048, ""},
		{"probe error", 0, errors.New("x"), CheckFail, 1024, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			chk := NewDiskCheck(&fakeHost{free: c.free, total: 10 << 30, diskErr: c.err}, "/data", c.minMB)
			r := chk.Check(context.Background())
			if chk.Name() != "disk" || r.Status != c.want || r.Detail == "" {
				t.Errorf("%+v", r)
			}
		})
	}
}

func promFile(local, offsite time.Time) string {
	s := "# HELP backup_last_success_timestamp Unix time of the last successful backup per target.\n" +
		"# TYPE backup_last_success_timestamp gauge\n"
	if !local.IsZero() {
		s += fmt.Sprintf("backup_last_success_timestamp{target=\"local\"} %d\n", local.Unix())
	}
	if !offsite.IsZero() {
		s += fmt.Sprintf("backup_last_success_timestamp{target=\"offsite\"} %d\n", offsite.Unix())
	}
	return s
}

func TestBackupCheck(t *testing.T) {
	clk := &fakeClock{sysNow}
	cases := []struct {
		name string
		host *fakeHost
		want CheckStatus
	}{
		{"fresh", &fakeHost{metrics: promFile(sysNow.Add(-3*time.Hour), sysNow.Add(-5*time.Hour))}, CheckOK},
		{"local too old", &fakeHost{metrics: promFile(sysNow.Add(-37*time.Hour), sysNow.Add(-1*time.Hour))}, CheckWarn},
		{"offsite too old", &fakeHost{metrics: promFile(sysNow.Add(-1*time.Hour), sysNow.Add(-40*time.Hour))}, CheckWarn},
		{"offsite missing", &fakeHost{metrics: promFile(sysNow.Add(-1*time.Hour), time.Time{})}, CheckWarn},
		{"empty file", &fakeHost{metrics: ""}, CheckWarn},
		{"missing file", &fakeHost{metricsErr: fmt.Errorf("open: %w", fs.ErrNotExist)}, CheckWarn},
		{"unreadable file", &fakeHost{metricsErr: errors.New("permission denied")}, CheckWarn},
		{"exactly 36h is still ok", &fakeHost{metrics: promFile(sysNow.Add(-36*time.Hour), sysNow.Add(-36*time.Hour))}, CheckOK},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			chk := NewBackupCheck(c.host, clk)
			r := chk.Check(context.Background())
			if chk.Name() != "backups" || r.Status != c.want || r.Detail == "" {
				t.Errorf("%+v", r)
			}
		})
	}
}

func TestParseBackupTimestampsIgnoresNoise(t *testing.T) {
	got := parseBackupTimestamps("garbage\n" +
		"other_metric{target=\"local\"} 5\n" +
		"backup_last_success_timestamp{target=\"local\"} abc\n" +
		"backup_last_success_timestamp{target=\"offsite\"}\n" +
		"backup_last_success_timestamp{} 100\n" +
		"backup_last_success_timestamp{job=\"x\",target=\"local\"} 1.7e9\n")
	if len(got) != 1 || got["local"].Unix() != 1700000000 {
		t.Errorf("got %v", got)
	}
}
