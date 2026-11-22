// Package timings is the trierarch's timings that only the contract suite
// shortens: the pass interval, init's wait for one stable service process and
// the first restart delay. Without the test timing setting each is its
// production value.
package timings

import (
	"strconv"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// Variable names the test timing setting: a whole number every timing here is divided by. Only tests set it.
const Variable = "AEOLUS_TRIERARCH_TEST_TIMING_DIVISOR"

// The production values; the first restart delay is the reconciler's first, RestartDelays[0].
const (
	PassInterval  = 5 * time.Second
	InitStability = 10 * time.Second
)

// Timings are the timings the trierarch runs at.
type Timings struct {
	// PassInterval is the wait between one pass and the next.
	PassInterval time.Duration
	// InitStability is how long init waits for the service to keep one process before it reports success.
	InitStability time.Duration
	// FirstRestartDelay is the wait before the first restart of a session that died.
	FirstRestartDelay time.Duration
}

// Of is the timings the environment gives: each production value divided by the test timing setting, or the production values when the setting is not a whole number above one.
func Of(environ []string) Timings {
	divisor := 1
	for _, entry := range environ {
		if name, value, ok := strings.Cut(entry, "="); ok && name == Variable {
			if parsed, err := strconv.Atoi(value); err == nil && parsed > 1 {
				divisor = parsed
			}
		}
	}
	by := time.Duration(divisor)
	return Timings{PassInterval: PassInterval / by, InitStability: InitStability / by, FirstRestartDelay: reconciler.RestartDelays[0] / by}
}
