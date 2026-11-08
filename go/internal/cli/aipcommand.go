package cli

import (
	"context"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/aipcommand"
)

// AipCommand is the aip CLI the trierarch keeps for its host sessions (#314), as aipcommand.Folder keeps it.
type AipCommand interface {
	// Ensure installs aip at its pin unless the folder holds it already, and says how it stands.
	Ensure() aipcommand.State
	// Bin is the folder's bin while it holds aip at its pin, without running anything.
	Bin() (string, bool)
	// State is how it stood after its last install.
	State() aipcommand.State
}

// retryFailedEvery is how long run waits before it tries a failed install again, so a host that cannot install aip is not at it every pass.
const retryFailedEvery = time.Hour

// keepAipCommand installs the aip CLI as run starts unless its folder holds it, and again on a pass that finds its folder broken; a failed install is tried again an hour on. It ends with ctx.
func keepAipCommand(ctx context.Context, command AipCommand, every time.Duration) {
	if command == nil {
		return
	}
	lastFailed := time.Time{}
	// The start checks the folder's aip itself, which the passes after leave to its files.
	isStart := true
	for {
		if _, ok := command.Bin(); isStart || (!ok && (lastFailed.IsZero() || time.Since(lastFailed) >= retryFailedEvery)) {
			isStart = false
			if command.Ensure().Version == "" {
				lastFailed = time.Now()
			} else {
				lastFailed = time.Time{}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}

// aipCommandSaid is what init and upgrade say of the aip CLI.
func aipCommandSaid(state aipcommand.State, folder string) string {
	if state.Version != "" {
		return "Host sessions run aip " + state.Version + ", which the trierarch keeps in " + folder + "."
	}
	return "Host sessions get no aip: " + state.Missing + "."
}

// describeAipCommand is how status says the aip CLI.
func describeAipCommand(state aipcommand.State) string {
	if state.Version != "" {
		return state.Version + " for host sessions"
	}
	return "none for host sessions: " + state.Missing
}
