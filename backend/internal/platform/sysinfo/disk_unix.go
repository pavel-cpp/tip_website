//go:build unix

package sysinfo

import (
	"fmt"
	"syscall"
)

func diskUsage(path string) (free, total uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, fmt.Errorf("statfs %s: %w", path, err)
	}
	bs := uint64(st.Bsize)                                     //nolint:gosec // block size is positive
	return uint64(st.Bavail) * bs, uint64(st.Blocks) * bs, nil //nolint:unconvert // field widths differ per OS
}
