package sessions

import (
	"crypto/rand"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
)

// WorkingTime is how long the session worked during this crew, as of now.
func (r Runtime) WorkingTime(shipID string, shipFolder string, now time.Time) (time.Duration, bool) {
	path := hold.WorkingTimePath(shipFolder)
	if path == "" {
		return 0, false
	}
	if elapsed, ok := hold.ReadWorkingTime(path, now, false); ok {
		return elapsed, true
	}
	if r.Root(shipID) == 0 {
		return 0, false
	}
	return hold.ReadWorkingTime(path, now, true)
}

// PauseWorkingTime pauses counting while the ship waits on a permission question.
func (r Runtime) PauseWorkingTime(shipID string) func() {
	id := rand.Text()
	_ = r.must(shipID, hold.Request{Call: "wait-started", Line: id}, callTimeout)
	return func() {
		_ = r.must(shipID, hold.Request{Call: "wait-ended", Line: id}, callTimeout)
	}
}
