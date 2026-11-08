package blobfs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

func hash(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func newStore(t *testing.T, minFreeMB, maxTotalMB int) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := New(dir, minFreeMB, maxTotalMB)
	if err != nil {
		t.Fatal(err)
	}
	return s, dir
}

func TestPutOpenDelete(t *testing.T) {
	s, dir := newStore(t, 0, 0)
	ctx := context.Background()
	data := []byte("hello image")
	sha := hash(data)

	if err := s.Put(ctx, sha, data); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "uploads", "projects", sha[:2], sha)); err != nil {
		t.Fatalf("file not at expected path: %v", err)
	}
	if err := s.Put(ctx, sha, data); err != nil { // dedupe
		t.Fatal(err)
	}
	r, err := s.Open(ctx, sha)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(r)
	_ = r.Close()
	if string(got) != string(data) {
		t.Fatalf("content %q", got)
	}
	if err := s.Delete(ctx, sha); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, sha); err != nil {
		t.Fatalf("second delete: %v", err)
	}
	if _, err := s.Open(ctx, sha); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("got %v", err)
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "tmp"))
	if len(entries) != 0 {
		t.Fatalf("tmp not clean: %v", entries)
	}
}

func TestInvalidHash(t *testing.T) {
	s, _ := newStore(t, 0, 0)
	ctx := context.Background()
	for _, bad := range []string{"", "../../etc/passwd", "ABC", hash(nil)[:63] + "G"} {
		if err := s.Put(ctx, bad, []byte("x")); err == nil {
			t.Errorf("Put(%q) succeeded", bad)
		}
		if _, err := s.Open(ctx, bad); !errors.Is(err, domain.ErrNotFound) {
			t.Errorf("Open(%q) = %v", bad, err)
		}
		if err := s.Delete(ctx, bad); err == nil {
			t.Errorf("Delete(%q) succeeded", bad)
		}
	}
}

func TestLimits(t *testing.T) {
	ctx := context.Background()
	t.Run("total", func(t *testing.T) {
		s, _ := newStore(t, 0, 1)
		s.maxTotal = 10
		a, b := []byte("123456"), []byte("abcdef")
		if err := s.Put(ctx, hash(a), a); err != nil {
			t.Fatal(err)
		}
		if err := s.Put(ctx, hash(b), b); !errors.Is(err, domain.ErrDiskLow) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("free space", func(t *testing.T) {
		s, _ := newStore(t, 1, 0)
		s.minFree = 1 << 60
		if err := s.Put(ctx, hash([]byte("x")), []byte("x")); !errors.Is(err, domain.ErrDiskLow) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("free bytes works on this platform", func(t *testing.T) {
		n, err := freeBytes(t.TempDir())
		if err != nil || n == 0 {
			t.Fatalf("freeBytes = %d, %v", n, err)
		}
	})
}

func TestNewCleansTmp(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "tmp"), 0o750); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dir, "tmp", "upload-stale")
	if err := os.WriteFile(stale, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(dir, 0, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale tmp file survived: %v", err)
	}
}

func TestGC(t *testing.T) {
	s, dir := newStore(t, 0, 0)
	ctx := context.Background()
	put := func(content string) string {
		sha := hash([]byte(content))
		if err := s.Put(ctx, sha, []byte(content)); err != nil {
			t.Fatal(err)
		}
		return sha
	}
	old := func(sha string) {
		past := time.Now().Add(-48 * time.Hour)
		if err := os.Chtimes(filepath.Join(dir, "uploads", "projects", sha[:2], sha), past, past); err != nil {
			t.Fatal(err)
		}
	}
	keepRef, oldOrphan, freshOrphan := put("ref"), put("old"), put("fresh")
	old(keepRef)
	old(oldOrphan)

	n, err := s.GC(ctx, map[string]struct{}{keepRef: {}})
	if err != nil || n != 1 {
		t.Fatalf("removed %d, err %v", n, err)
	}
	for sha, want := range map[string]bool{keepRef: true, oldOrphan: false, freshOrphan: true} {
		r, err := s.Open(ctx, sha)
		if r != nil {
			_ = r.Close()
		}
		if (err == nil) != want {
			t.Errorf("%s: exists=%v want %v", sha[:6], err == nil, want)
		}
	}
	// Re-putting an old orphan refreshes its mtime so it is not collected right away.
	old(freshOrphan)
	put("fresh")
	if n, _ := s.GC(ctx, map[string]struct{}{keepRef: {}}); n != 0 {
		t.Fatalf("refreshed file was collected (%d)", n)
	}
}

func TestThumbSidecarFollowsOriginal(t *testing.T) {
	s, dir := newStore(t, 0, 0)
	ctx := context.Background()
	sha := hash([]byte("original"))
	key := domain.ThumbKey(sha)
	if err := s.Put(ctx, sha, []byte("original")); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(ctx, key, []byte("preview")); err != nil {
		t.Fatalf("put preview: %v", err)
	}
	past := time.Now().Add(-48 * time.Hour)
	for _, k := range []string{sha, key} {
		if err := os.Chtimes(filepath.Join(dir, "uploads", "projects", sha[:2], k), past, past); err != nil {
			t.Fatal(err)
		}
	}
	// Referenced original: the preview survives with it.
	if n, err := s.GC(ctx, map[string]struct{}{sha: {}}); err != nil || n != 0 {
		t.Fatalf("referenced pair collected: n=%d err=%v", n, err)
	}
	// Unreferenced: both files go.
	if n, err := s.GC(ctx, nil); err != nil || n != 2 {
		t.Fatalf("removed %d, err %v", n, err)
	}
	if err := s.Put(ctx, key, []byte("preview")); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Open(ctx, key); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("deleted preview still opens: %v", err)
	}
}
