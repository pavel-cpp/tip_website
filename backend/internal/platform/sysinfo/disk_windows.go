//go:build windows

package sysinfo

import (
	"fmt"
	"syscall"
	"unsafe"
)

var getDiskFreeSpaceEx = syscall.NewLazyDLL("kernel32.dll").NewProc("GetDiskFreeSpaceExW")

func diskUsage(path string) (free, total uint64, err error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0, fmt.Errorf("disk usage %s: %w", path, err)
	}
	var avail, totalBytes, totalFree uint64
	r, _, callErr := getDiskFreeSpaceEx.Call(
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&avail)),
		uintptr(unsafe.Pointer(&totalBytes)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if r == 0 {
		return 0, 0, fmt.Errorf("GetDiskFreeSpaceEx %s: %w", path, callErr)
	}
	return avail, totalBytes, nil
}
