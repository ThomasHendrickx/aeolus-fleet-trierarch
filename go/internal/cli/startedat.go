package cli

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

var etimePattern = regexp.MustCompile(`^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$`)

// StartedAtFrom is when a process started, ISO 8601 in UTC with milliseconds, from how long it runs as `ps -o etime=` says it ([[dd-]hh:]mm:ss); empty when ps said something else.
func StartedAtFrom(etime string, now time.Time) string {
	match := etimePattern.FindStringSubmatch(strings.TrimSpace(etime))
	if match == nil {
		return ""
	}
	number := func(text string) time.Duration {
		value, _ := strconv.Atoi(text)
		return time.Duration(value)
	}
	elapsed := number(match[1])*24*time.Hour + number(match[2])*time.Hour + number(match[3])*time.Minute + number(match[4])*time.Second
	return now.Add(-elapsed).UTC().Format("2006-01-02T15:04:05.000Z")
}
