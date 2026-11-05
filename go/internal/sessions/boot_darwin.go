package sessions

import (
	"time"

	"golang.org/x/sys/unix"
)

// BootedAt is when the machine started, from the kernel's kern.boottime; zero when it cannot be read.
func BootedAt() time.Time {
	booted, err := unix.SysctlTimeval("kern.boottime")
	if err != nil {
		return time.Time{}
	}
	return time.Unix(booted.Sec, int64(booted.Usec)*int64(time.Microsecond))
}
