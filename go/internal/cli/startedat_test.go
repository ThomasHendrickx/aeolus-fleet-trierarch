package cli

import (
	"testing"
	"time"
)

func TestStartedAtFromHowLongAProcessRuns(t *testing.T) {
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	for etime, want := range map[string]string{
		"00:05":      "2026-10-06T11:59:55.000Z",
		" 12:30\n":   "2026-10-06T11:47:30.000Z",
		"02:01:01":   "2026-10-06T09:58:59.000Z",
		"3-02:00:00": "2026-10-03T10:00:00.000Z",
		"":           "",
		"not a time": "",
		"1:2:3:4":    "",
	} {
		if got := StartedAtFrom(etime, now); got != want {
			t.Errorf("%q: %q, want %q", etime, got, want)
		}
	}
}
