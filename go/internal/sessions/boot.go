package sessions

import (
	"strconv"
	"strings"
	"time"
)

// bootedBefore is when the machine started, given the uptime text that begins with its seconds up and the time now; zero when the text states none.
func bootedBefore(uptime string, now time.Time) time.Time {
	fields := strings.Fields(uptime)
	if len(fields) == 0 {
		return time.Time{}
	}
	seconds, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return time.Time{}
	}
	return now.Add(-time.Duration(seconds * float64(time.Second)))
}
