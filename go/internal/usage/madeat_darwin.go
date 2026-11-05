package usage

import (
	"os"
	"syscall"
	"time"
)

// FolderMadeAt is when the folder was made, so what a session of another crew in a folder of the same name used counts not.
func FolderMadeAt(folder string) (time.Time, error) {
	info, err := os.Stat(folder)
	if err != nil {
		return time.Time{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return info.ModTime(), nil
	}
	if stat.Birthtimespec.Sec != 0 || stat.Birthtimespec.Nsec != 0 {
		return time.Unix(stat.Birthtimespec.Sec, stat.Birthtimespec.Nsec), nil
	}
	// Where the filesystem keeps no birth time: when its entry last changed, as today's trierarch reads it.
	return time.Unix(stat.Ctimespec.Sec, stat.Ctimespec.Nsec), nil
}
