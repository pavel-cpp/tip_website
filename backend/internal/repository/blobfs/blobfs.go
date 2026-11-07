// Package blobfs is the content-addressed file store for project images:
// DATA_DIR/uploads/projects/<sha[0:2]>/<sha>. Files are immutable, so writes are
// tmp -> fsync -> rename and readers never observe partial content.
package blobfs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// GCMinAge is how long an unreferenced file is kept before the GC removes it; it covers the
// window between writing a blob and committing the row that references it.
const GCMinAge = 24 * time.Hour

// Store is the file store. It is safe for concurrent use.
type Store struct {
	projects string // DATA_DIR/uploads/projects
	tmp      string // DATA_DIR/tmp
	minFree  int64  // bytes that must stay free after a write
	maxTotal int64  // ceiling for the total size of stored files
	now      func() time.Time
}

// New prepares the directory layout under dataDir and removes leftovers of interrupted uploads
// from the tmp directory. minFreeMB and maxTotalMB of zero disable the respective check.
func New(dataDir string, minFreeMB, maxTotalMB int) (*Store, error) {
	s := &Store{
		projects: filepath.Join(dataDir, "uploads", "projects"),
		tmp:      filepath.Join(dataDir, "tmp"),
		minFree:  int64(minFreeMB) << 20,
		maxTotal: int64(maxTotalMB) << 20,
		now:      time.Now,
	}
	if err := os.MkdirAll(s.projects, 0o750); err != nil {
		return nil, fmt.Errorf("create uploads dir: %w", err)
	}
	if err := os.RemoveAll(s.tmp); err != nil {
		return nil, fmt.Errorf("clean tmp dir: %w", err)
	}
	if err := os.MkdirAll(s.tmp, 0o750); err != nil {
		return nil, fmt.Errorf("create tmp dir: %w", err)
	}
	return s, nil
}

func validSHA(sha string) bool {
	if len(sha) != 64 {
		return false
	}
	for i := 0; i < len(sha); i++ {
		c := sha[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func (s *Store) path(sha string) string {
	return filepath.Join(s.projects, sha[:2], sha)
}

// Put stores data under its hash sha. The caller guarantees sha is the SHA-256 of data. An
// existing file is kept and its mtime refreshed so the GC grace period restarts. It returns
// domain.ErrDiskLow when the write would break the free-space or total-size limit.
func (s *Store) Put(ctx context.Context, sha string, data []byte) error {
	if !validSHA(sha) {
		return fmt.Errorf("blobfs: invalid hash")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	dst := s.path(sha)
	if _, err := os.Stat(dst); err == nil {
		now := s.now()
		return os.Chtimes(dst, now, now)
	}
	if err := s.checkLimits(int64(len(data))); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
		return fmt.Errorf("create blob dir: %w", err)
	}
	f, err := os.CreateTemp(s.tmp, "upload-*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpName := f.Name()
	defer func() { _ = os.Remove(tmpName) }() // no-op after a successful rename
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return fmt.Errorf("sync temp file: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Rename(tmpName, dst); err != nil {
		return fmt.Errorf("publish blob: %w", err)
	}
	return nil
}

func (s *Store) checkLimits(n int64) error {
	if s.minFree > 0 {
		free, err := freeBytes(s.projects)
		if err != nil {
			return fmt.Errorf("disk stats: %w", err)
		}
		if int64(free)-n < s.minFree {
			return domain.ErrDiskLow
		}
	}
	if s.maxTotal > 0 {
		total, err := s.totalSize()
		if err != nil {
			return err
		}
		if total+n > s.maxTotal {
			return domain.ErrDiskLow
		}
	}
	return nil
}

// totalSize sums the sizes of all stored files; the set is small (one file per project image).
func (s *Store) totalSize() (int64, error) {
	var total int64
	err := filepath.WalkDir(s.projects, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			info, err := d.Info()
			if err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					return nil
				}
				return err
			}
			total += info.Size()
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("measure uploads: %w", err)
	}
	return total, nil
}

// Open returns a handle to the stored file, or domain.ErrNotFound. The caller closes it.
func (s *Store) Open(_ context.Context, sha string) (io.ReadSeekCloser, error) {
	if !validSHA(sha) {
		return nil, domain.ErrNotFound
	}
	f, err := os.Open(s.path(sha))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, domain.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("open blob: %w", err)
	}
	return f, nil
}

// Delete removes the file; a missing file is not an error. An open handle keeps working on
// platforms that allow unlinking open files.
func (s *Store) Delete(_ context.Context, sha string) error {
	if !validSHA(sha) {
		return fmt.Errorf("blobfs: invalid hash")
	}
	if err := os.Remove(s.path(sha)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("delete blob: %w", err)
	}
	return nil
}

// GC removes files that are absent from referenced and older than GCMinAge. It returns the
// number of removed files. Files whose name is not a valid hash are left alone.
func (s *Store) GC(ctx context.Context, referenced map[string]struct{}) (int, error) {
	cutoff := s.now().Add(-GCMinAge)
	removed := 0
	err := filepath.WalkDir(s.projects, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		if !d.Type().IsRegular() || !validSHA(d.Name()) {
			return nil
		}
		if _, ok := referenced[d.Name()]; ok {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if info.ModTime().After(cutoff) {
			return nil
		}
		if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		removed++
		return nil
	})
	if err != nil {
		return removed, fmt.Errorf("collect garbage: %w", err)
	}
	return removed, nil
}
