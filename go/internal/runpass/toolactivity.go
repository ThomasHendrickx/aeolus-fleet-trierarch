package runpass

import (
	"context"
	"fmt"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/activity"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/fleet"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// ToolCalls reads the guard's decisions in the order the session made them.
type ToolCalls interface {
	ReadToolCalls(ctx context.Context, shipID string, offset int64, limit int) ([]guard.CallActivity, int64, error)
}

// One ship's rejected observation cannot advance another ship's cursor.
func (p Pass) writeToolActivity(ctx context.Context, state reconciler.State, entry reconciler.Entry, shown activity.Activity, hasShown bool) bool {
	const callsPerPass = 100
	calls, next, err := p.ToolCalls.ReadToolCalls(ctx, entry.ShipID, entry.ToolCallsReported, callsPerPass)
	if err != nil {
		p.Log(fmt.Sprintf("The tool calls of %s were not read: %v; the next pass tries again", nameOf(entry), err))
		return true
	}
	if len(calls) == 0 && (!hasShown || shown.Kind != "tool") {
		return false
	}
	var observations []fleet.ShipActivity
	for _, call := range calls {
		kind := "tool"
		if call.Result == "refused" {
			kind = "refused"
		}
		observations = append(observations, fleet.ShipActivity{ShipID: entry.ShipID, Activity: activity.Activity{
			At: call.At, Kind: kind, Tool: call.Tool, Reason: call.Reason,
		}})
	}
	reported := entry.ToolEventReported
	if hasShown && len(calls) < callsPerPass && (len(calls) == 0 || shown.At.After(calls[len(calls)-1].At)) {
		if shown.Kind == "tool" {
			// The harness reports its own copy of the call. The guard's decision is authoritative.
			key := shown.At.Format(time.RFC3339Nano) + ":" + shown.Tool
			hasShown = next == 0 && key != reported
			if hasShown {
				reported = key
			}
		}
		if hasShown {
			observations = append(observations, fleet.ShipActivity{ShipID: entry.ShipID, Activity: shown})
		}
	}
	if len(observations) == 0 {
		return true
	}
	if err := p.Fleet.ReportActivity(activityIntervalSeconds, observations); err != nil {
		p.Log(fmt.Sprintf("The activity of %s was not written: %v; the next pass tries again", nameOf(entry), err))
		return true
	}
	if next == entry.ToolCallsReported && reported == entry.ToolEventReported {
		return true
	}
	entry.ToolCallsReported, entry.ToolEventReported = next, reported
	if _, err := p.put(state, entry); err != nil {
		p.Log(fmt.Sprintf("The activity reported for %s was not kept: %v", nameOf(entry), err))
	}
	return true
}
