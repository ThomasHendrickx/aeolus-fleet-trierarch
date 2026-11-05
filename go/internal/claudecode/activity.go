package claudecode

import (
	"encoding/json"
	"slices"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/activity"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// ActivityIn is what the latest of Claude Code's stream-json events that shows activity says its session is doing.
func ActivityIn(events []string) (activity.Reading, bool) {
	return activity.Latest(events, readActivity)
}

// Activity is what the entry's session did last, from its hold's events.
func (h Harness) Activity(entry reconciler.Entry) (activity.Activity, bool) {
	return activity.Of(h.Events(entry.ShipID), readActivity)
}

// block is one block of a message's content.
type block struct {
	Type string `json:"type"`
	Name string `json:"name"`
}

func readActivity(line string) (activity.Reading, bool) {
	var event struct {
		Type    string `json:"type"`
		IsError bool   `json:"is_error"`
		Message *struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal([]byte(line), &event) != nil {
		return activity.Reading{}, false
	}
	if event.Type == "result" {
		if event.IsError {
			return activity.Reading{Kind: "error"}, true
		}
		return activity.Reading{Kind: "result"}, true
	}
	if event.Message == nil {
		return activity.Reading{}, false
	}
	var blocks []block
	if json.Unmarshal(event.Message.Content, &blocks) != nil {
		return activity.Reading{}, false
	}
	switch event.Type {
	case "user":
		if slices.ContainsFunc(blocks, func(b block) bool { return b.Type == "tool_result" }) {
			return activity.Reading{Kind: "result"}, true
		}
	case "assistant":
		for i := len(blocks) - 1; i >= 0; i-- {
			if blocks[i].Type == "tool_use" {
				return activity.Reading{Kind: "tool", Tool: blocks[i].Name}, true
			}
		}
		for _, block := range blocks {
			if block.Type == "text" {
				return activity.Reading{Kind: "text"}, true
			}
		}
	}
	return activity.Reading{}, false
}
