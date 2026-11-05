// Package failedstarts is the machine's failed session starts (docs/trierarch.md,
// "Crewing a ship", aeolus-fleet#853): once the last start of 3 different ships
// failed, with no start succeeding since, the cause is the machine's, not one
// ship's settings, so the trierarch stops offering itself for placement. It
// offers itself again, as a probe, 10 minutes after its last failed start, with
// room for one start until a start decides; a start that succeeds, or another
// configuration, offers it for good.
package failedstarts

import (
	"fmt"
	"slices"
	"time"
	"unicode/utf16"
)

// ShipsToStop is how many different ships' last starts must fail in a row before the machine stops offering itself.
const ShipsToStop = 3

// ProbeAfter is how long after its last failed start a machine that stopped offering itself offers itself again for a probe: the restart policy's longest wait.
const ProbeAfter = 10 * time.Minute

// reasonMaxLength is how long the reason a report gives for not offering may be, in the UTF-16 units a JavaScript string counts them in, as the fleet counts them.
const reasonMaxLength = 280

// isoMillis is a time as today's trierarch writes it, to the millisecond in UTC.
const isoMillis = "2006-01-02T15:04:05.000Z"

// Starts are the failed starts since a start last succeeded, as the state keeps them.
type Starts struct {
	// ShipIDs are the ships whose last start failed, each once, in the order they first failed.
	ShipIDs []string `json:"shipIds"`
	// Reason is why the first start of this run failed: the cause, where later failures are often its consequence.
	Reason string `json:"reason"`
	// At is when the last start failed, ISO 8601.
	At string `json:"at"`
	// Stopped is set once the machine stopped offering itself.
	Stopped *Stopped `json:"stopped,omitempty"`
}

// Stopped is when the machine stopped offering itself, and the configuration it ran with then.
type Stopped struct {
	Since         string `json:"since"`
	Configuration string `json:"configuration"`
}

// Outcome is how a session start ended: activity in its launch window, or a failed start of the machine's with why.
type Outcome struct {
	ShipID    string
	IsSuccess bool
	Reason    string
}

// Count counts one start: a success clears the count; a failure adds its ship, and the third ship stops the machine offering itself. It answers whether this start stopped it, so argo is told once.
func Count(starts *Starts, outcome Outcome, now time.Time, configuration string) (*Starts, bool) {
	if outcome.IsSuccess {
		return nil, false
	}
	counted := Starts{At: now.UTC().Format(isoMillis), Reason: outcome.Reason}
	if starts != nil {
		counted.Reason, counted.ShipIDs, counted.Stopped = starts.Reason, starts.ShipIDs, starts.Stopped
	}
	if !slices.Contains(counted.ShipIDs, outcome.ShipID) {
		counted.ShipIDs = append(append([]string{}, counted.ShipIDs...), outcome.ShipID)
	}
	if counted.Stopped != nil || len(counted.ShipIDs) < ShipsToStop {
		return &counted, false
	}
	counted.Stopped = &Stopped{Since: counted.At, Configuration: configuration}
	return &counted, true
}

// WithConfiguration is the failed starts as the trierarch starts with this configuration: another one than it stopped with offers it again.
func WithConfiguration(starts *Starts, configuration string) *Starts {
	if starts != nil && starts.Stopped != nil && starts.Stopped.Configuration != configuration {
		return nil
	}
	return starts
}

// IsOffering is whether the machine offers itself for placement now: always, unless it stopped and its probe is not due yet.
func IsOffering(starts *Starts, now time.Time) bool {
	return starts == nil || starts.Stopped == nil || !now.Before(offersAgainAt(*starts))
}

// IsProbing is whether the machine stopped offering itself and its probe is due: it offers room for one start only, until a start decides.
func IsProbing(starts *Starts, now time.Time) bool {
	return starts != nil && starts.Stopped != nil && IsOffering(starts, now)
}

// ProbeShipsCap is the ships cap a probe reports: the ships it holds, with room for one more only while none of their starts is undecided.
func ProbeShipsCap(held int, ships int, isStartUndecided bool) int {
	if isStartUndecided {
		return min(ships, held)
	}
	return min(ships, held+1)
}

// NotOfferedReason is why the machine does not offer itself, as its report names it for each harness.
func NotOfferedReason(starts Starts) string {
	offersAgain := "; it offers itself again at " + offersAgainAt(starts).UTC().Format(isoMillis)
	failed := fmt.Sprintf("the starts of %d ships failed in a row; first: %s", len(starts.ShipIDs), starts.Reason)
	units := utf16.Encode([]rune(failed))
	room := reasonMaxLength - len(utf16.Encode([]rune(offersAgain)))
	if len(units) > room {
		failed = string(utf16.Decode(units[:room]))
	}
	return failed + offersAgain
}

func offersAgainAt(starts Starts) time.Time {
	at, err := time.Parse(time.RFC3339Nano, starts.At)
	if err != nil {
		return time.Time{}
	}
	return at.Add(ProbeAfter)
}
