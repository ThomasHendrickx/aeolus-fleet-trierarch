package shipview

import (
	"testing"
	"time"
)

func TestAgeUsesHoursFromOneHour(t *testing.T) {
	for _, tc := range []struct {
		elapsed time.Duration
		want    string
	}{
		{time.Hour - time.Second, "60m"},
		{time.Hour, "1h"},
		{time.Hour + time.Second, "1h"},
		{3 * time.Hour, "3h"},
	} {
		t.Run(tc.elapsed.String(), func(t *testing.T) {
			if got := Age(tc.elapsed); got != tc.want {
				t.Fatalf("Age(%s) = %q, want %q", tc.elapsed, got, tc.want)
			}
		})
	}
}
