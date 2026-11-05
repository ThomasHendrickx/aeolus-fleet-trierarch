package copilot

import (
	"encoding/json"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/activity"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// ActivityIn is what the latest of Copilot's JSON events that shows activity says its session is doing.
func ActivityIn(events []string) (activity.Reading, bool) {
	return activity.Latest(events, readActivity)
}

// Activity is what the entry's session did last, from its hold's events.
func (h Harness) Activity(entry reconciler.Entry) (activity.Activity, bool) {
	return activity.Of(h.Events(entry.ShipID), readActivity)
}

func readActivity(line string) (activity.Reading, bool) {
	var event struct {
		Type string `json:"type"`
		Data struct {
			ToolName string `json:"toolName"`
			Content  string `json:"content"`
		} `json:"data"`
	}
	if json.Unmarshal([]byte(line), &event) != nil {
		return activity.Reading{}, false
	}
	switch event.Type {
	case "tool.execution_start":
		return activity.Reading{Kind: "tool", Tool: event.Data.ToolName}, true
	case "tool.execution_complete", "result":
		return activity.Reading{Kind: "result"}, true
	case "session.error":
		return activity.Reading{Kind: "error"}, true
	case "assistant.message":
		if event.Data.Content != "" {
			return activity.Reading{Kind: "text"}, true
		}
	}
	return activity.Reading{}, false
}
