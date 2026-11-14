package permissions

import (
	"context"
	"testing"
	"time"
)

type controlledTimer struct {
	done    chan time.Time
	stopped bool
}

func (t *controlledTimer) Done() <-chan time.Time { return t.done }
func (t *controlledTimer) Stop()                  { t.stopped = true }

type controlledClock struct {
	timer    *controlledTimer
	duration chan time.Duration
}

func (c controlledClock) NewTimer(after time.Duration) Timer { c.duration <- after; return c.timer }

func TestWaitReadsItsLimitFromTheInjectedClockAndStopsTheTimerOnEveryEnd(t *testing.T) {
	for _, end := range []string{"limit", "cancel"} {
		t.Run(end, func(t *testing.T) {
			timer := &controlledTimer{done: make(chan time.Time)}
			duration := make(chan time.Duration, 1)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan Decision, 1)
			go func() { result <- Wait(ctx, controlledClock{timer: timer, duration: duration}) }()
			if got := <-duration; got != 30*time.Minute {
				t.Fatalf("limit = %s, want 30m", got)
			}
			if end == "cancel" {
				cancel()
			} else {
				timer.done <- time.Time{}
			}
			got := <-result
			if got.Behavior != "deny" || !timer.stopped {
				t.Fatalf("decision = %+v, stopped = %v", got, timer.stopped)
			}
		})
	}
}
