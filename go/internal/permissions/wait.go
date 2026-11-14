package permissions

import (
	"context"
	"time"
)

// Timer is a wait that its owner can stop on every end.
type Timer interface {
	Done() <-chan time.Time
	Stop()
}

// Clock supplies the permission limit without reading a clock in the use case.
type Clock interface{ NewTimer(time.Duration) Timer }

// SystemClock supplies process-owned timers.
type SystemClock struct{}
type systemTimer struct{ timer *time.Timer }

// NewTimer starts a timer that must be stopped by its caller.
func (SystemClock) NewTimer(after time.Duration) Timer { return systemTimer{time.NewTimer(after)} }
func (t systemTimer) Done() <-chan time.Time           { return t.timer.C }
func (t systemTimer) Stop()                            { t.timer.Stop() }

// Wait denies at the limit and releases its timer when the call is interrupted.
func Wait(ctx context.Context, clock Clock) Decision {
	timer := clock.NewTimer(30 * time.Minute)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return Decision{Behavior: "deny", Message: "permission call cancelled"}
	case <-timer.Done():
		return Decision{Behavior: "deny", Message: "not answered in 30 minutes; the question was withdrawn"}
	}
}
