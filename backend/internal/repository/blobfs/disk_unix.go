//go:build !windows

package blobfs

import "syscall"

// freeBytes returns the space available to an unprivileged process on the filesystem of dir.
func freeBytes(dir string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return uint64(st.Bavail) * uint64(st.Bsize), nil //nolint:gosec // Bavail and Bsize are never negative
}
