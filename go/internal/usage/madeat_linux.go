package usage

import (
	"encoding/binary"
	"os"
	"syscall"
	"time"
	"unsafe"
)

// Where statx(2) keeps what FolderMadeAt reads: the birth time asked for, and its place in struct statx.
var atFdcwd = -100

const (
	statxBtime  = 0x800
	statxSize   = 256
	maskOffset  = 0
	btimeOffset = 80
)

// FolderMadeAt is when the folder was made, so what a session of another crew in a folder of the same name used counts not; when it changed last where the filesystem keeps no birth time, as today's trierarch reads it.
func FolderMadeAt(folder string) (time.Time, error) {
	path, err := syscall.BytePtrFromString(folder)
	if err != nil {
		return time.Time{}, err
	}
	var buffer [statxSize]byte
	if _, _, errno := syscall.Syscall6(sysStatx, uintptr(atFdcwd), uintptr(unsafe.Pointer(path)), 0, statxBtime, uintptr(unsafe.Pointer(&buffer[0])), 0); errno == 0 {
		seconds := int64(binary.LittleEndian.Uint64(buffer[btimeOffset:]))
		nanoseconds := int64(binary.LittleEndian.Uint32(buffer[btimeOffset+8:]))
		if binary.LittleEndian.Uint32(buffer[maskOffset:])&statxBtime != 0 && (seconds != 0 || nanoseconds != 0) {
			return time.Unix(seconds, nanoseconds), nil
		}
	}
	return changedAt(folder)
}

// changedAt is when the folder's entry last changed (its ctime).
func changedAt(folder string) (time.Time, error) {
	info, err := os.Stat(folder)
	if err != nil {
		return time.Time{}, err
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return time.Unix(stat.Ctim.Sec, stat.Ctim.Nsec), nil
	}
	return info.ModTime(), nil
}
