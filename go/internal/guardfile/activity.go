package guardfile

import (
	"context"
	"fmt"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
)

const toolCallsFile = "tool-calls.jsonl"

// ToolCalls keeps the metadata of every guard check in the ship's guard folder.
type ToolCalls struct {
	Guards string
	ShipID string
}

// Append records the call at the end of its ship's activity file.
func (t ToolCalls) Append(ctx context.Context, call guard.CallActivity) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := appendRecord(t.Guards, t.ShipID, toolCallsFile, call); err != nil {
		return fmt.Errorf("record tool call: %w", err)
	}
	return nil
}
