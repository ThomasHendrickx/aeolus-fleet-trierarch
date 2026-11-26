package permissions

import (
	"context"
	"testing"
	"testing/synctest"
)

func TestAQuestionPausesWorkingTimeUntilTheWaitEnds(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		paused := ""
		service := Service{
			Owners: &owners{person: true}, Reports: &reports{}, Clock: SystemClock{},
			PauseWorkingTime: func(ship string) func() {
				paused = ship
				return func() { paused = "" }
			},
		}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan Decision, 1)
		go func() { done <- service.Await(ctx, "scout", "Run a check") }()
		synctest.Wait()
		if paused != "scout" {
			t.Fatalf("working time paused for %q, want scout", paused)
		}
		cancel()
		<-done
		if paused != "" {
			t.Fatalf("working time is still paused for %q", paused)
		}
	})
}
