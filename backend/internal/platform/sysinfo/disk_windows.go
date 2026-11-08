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
	// The Win32 call needs raw pointers to the output variables; they outlive the call.
	r, _, callErr := getDiskFreeSpaceEx.Call(
		uintptr(unsafe.Pointer(p)),           //nolint:gosec // required by the syscall ABI
		uintptr(unsafe.Pointer(&avail)),      //nolint:gosec // required by the syscall ABI
		uintptr(unsafe.Pointer(&totalBytes)), //nolint:gosec // required by the syscall ABI
		uintptr(unsafe.Pointer(&totalFree)),  //nolint:gosec // required by the syscall ABI
	)
	if r == 0 {
		return 0, 0, fmt.Errorf("GetDiskFreeSpaceEx %s: %w", path, callErr)
	}
	return avail, totalBytes, nil
}
