package codex

import (
	"encoding/json"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/activity"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// ActivityIn is what the latest of `codex exec --json`'s events that shows activity says its session is doing.
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
		Item *struct {
			Type string `json:"type"`
		} `json:"item"`
	}
	if json.Unmarshal([]byte(line), &event) != nil {
		return activity.Reading{}, false
	}
	switch event.Type {
	case "turn.completed":
		return activity.Reading{Kind: "result"}, true
	case "turn.failed", "error":
		return activity.Reading{Kind: "error"}, true
	case "item.started", "item.completed":
		switch {
		case event.Item == nil:
			return activity.Reading{}, false
		case event.Item.Type == "agent_message":
			return activity.Reading{Kind: "text"}, true
		case event.Item.Type == "error":
			return activity.Reading{Kind: "error"}, true
		}
		return activity.Reading{Kind: "tool", Tool: event.Item.Type}, true
	}
	return activity.Reading{}, false
}
