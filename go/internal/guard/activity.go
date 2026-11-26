package guard

import (
	"context"
	"strings"
	"time"
)

// CallActivity is one guard decision. It contains no tool arguments or results.
type CallActivity struct {
	At     time.Time `json:"at"`
	Tool   string    `json:"tool,omitempty"`
	Result string    `json:"result"`
	Reason string    `json:"reason,omitempty"`
}

// ActivityLog keeps one observation per guard check.
type ActivityLog interface {
	Append(ctx context.Context, call CallActivity) error
}

// activityWriteWait bounds the observation without depending on the fleet.
const activityWriteWait = 50 * time.Millisecond

func (c Checker) observe(ctx context.Context, tool string, refusal *verdict) {
	if c.Activity == nil || ctx.Err() != nil {
		return
	}
	bounded, cancel := context.WithTimeout(ctx, activityWriteWait)
	defer cancel()
	observation := CallActivity{At: c.Now(), Tool: tool, Result: "allowed"}
	if refusal != nil {
		observation.Result = "refused"
		observation.Reason = activityReason(refusal)
	}
	_, _ = guarded(bounded, func() error { return c.Activity.Append(bounded, observation) })
}

func activityReason(refusal *verdict) string {
	if refusal.set != nil {
		rule, _, _ := strings.Cut(refusal.rule, " ")
		return rule
	}
	if strings.HasPrefix(refusal.rule, "guard failed: ") {
		// The mechanism's failure causes are fixed strings from the checker.
		return refusal.rule
	}
	// Mechanism rules may include paths, names or words from the tool input.
	reason, _, _ := strings.Cut(refusal.rule, ":")
	return reason
}
