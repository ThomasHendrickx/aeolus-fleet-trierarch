package keys

import (
	"os"
	"strconv"
	"syscall"
)

func inodeOf(info os.FileInfo) string {
	return strconv.FormatUint(info.Sys().(*syscall.Stat_t).Ino, 10)
}

// millisecondsOf is the key file's mtimeMs as Node states it: seconds in milliseconds plus the nanoseconds as a fraction.
func millisecondsOf(info os.FileInfo) string {
	modified := info.ModTime()
	return strconv.FormatFloat(float64(modified.Unix())*1e3+float64(modified.Nanosecond())/1e6, 'f', -1, 64)
}
