package sysinfo

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestDiskUsage(t *testing.T) {
	free, total, err := Host{}.DiskUsage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if total == 0 || free > total {
		t.Errorf("implausible figures: free=%d total=%d", free, total)
	}
}

func TestDiskUsageMissingPath(t *testing.T) {
	if _, _, err := (Host{}).DiskUsage(filepath.Join(t.TempDir(), "nope", "nested")); err == nil {
		t.Fatal("expected an error for a missing path")
	}
}

func TestDirSize(t *testing.T) {
	root := t.TempDir()
	write := func(rel string, n int) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, make([]byte, n), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("a.bin", 100)
	write("sub/b.bin", 250)
	write("sub/deeper/c.bin", 50)

	got, err := Host{}.DirSize(context.Background(), root)
	if err != nil || got != 400 {
		t.Errorf("DirSize = %d, %v; want 400", got, err)
	}
}

func TestDirSizeMissingRootIsEmpty(t *testing.T) {
	got, err := Host{}.DirSize(context.Background(), filepath.Join(t.TempDir(), "absent"))
	if err != nil || got != 0 {
		t.Errorf("DirSize = %d, %v; want 0, nil", got, err)
	}
}

func TestDirSizeHonoursCancellation(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "f"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (Host{}).DirSize(ctx, root); !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want context.Canceled", err)
	}
}

func TestReadBackupMetrics(t *testing.T) {
	p := filepath.Join(t.TempDir(), "backup.prom")
	if err := os.WriteFile(p, []byte("backup_last_success_timestamp{target=\"local\"} 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := Host{BackupMetricsPath: p}.ReadBackupMetrics(context.Background())
	if err != nil || string(got) != "backup_last_success_timestamp{target=\"local\"} 1\n" {
		t.Errorf("got %q, %v", got, err)
	}
}

func TestReadBackupMetricsMissingFile(t *testing.T) {
	h := Host{BackupMetricsPath: filepath.Join(t.TempDir(), "backup.prom")}
	if _, err := h.ReadBackupMetrics(context.Background()); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("err = %v, want fs.ErrNotExist", err)
	}
}

func TestReadBackupMetricsIsBounded(t *testing.T) {
	p := filepath.Join(t.TempDir(), "big.prom")
	if err := os.WriteFile(p, make([]byte, maxMetricsFile+1000), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := Host{BackupMetricsPath: p}.ReadBackupMetrics(context.Background())
	if err != nil || len(got) != maxMetricsFile {
		t.Errorf("len = %d, %v; want %d", len(got), err, maxMetricsFile)
	}
}
