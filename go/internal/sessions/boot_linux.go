package sessions

import (
	"os"
	"time"
)

// BootedAt is when the machine started, from /proc/uptime; zero when it cannot be read.
func BootedAt() time.Time {
	text, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return time.Time{}
	}
	return bootedBefore(string(text), time.Now())
}
