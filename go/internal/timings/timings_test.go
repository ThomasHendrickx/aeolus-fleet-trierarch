package timings

import (
	"testing"
	"time"
)

func TestTimingsAreTheProductionValuesWithoutTheSetting(t *testing.T) {
	want := Timings{PassInterval: 5 * time.Second, InitStability: 10 * time.Second, FirstRestartDelay: 5 * time.Second}
	if got := Of([]string{"PATH=/usr/bin"}); got != want {
		t.Errorf("Of(no setting) = %+v, want %+v", got, want)
	}
}

func TestTheTestSettingDividesEveryTiming(t *testing.T) {
	want := Timings{PassInterval: time.Second, InitStability: 2 * time.Second, FirstRestartDelay: time.Second}
	if got := Of([]string{"AEOLUS_TRIERARCH_TEST_TIMING_DIVISOR=5"}); got != want {
		t.Errorf("Of(divisor 5) = %+v, want %+v", got, want)
	}
}

func TestASettingThatIsNoWholeNumberOfAtLeastOneLeavesTheProductionValues(t *testing.T) {
	want := Timings{PassInterval: 5 * time.Second, InitStability: 10 * time.Second, FirstRestartDelay: 5 * time.Second}
	for _, value := range []string{"", "0", "-5", "fast", "2.5", "1"} {
		t.Run(value, func(t *testing.T) {
			if got := Of([]string{"AEOLUS_TRIERARCH_TEST_TIMING_DIVISOR=" + value}); got != want {
				t.Errorf("Of(divisor %q) = %+v, want %+v", value, got, want)
			}
		})
	}
}
