package codex

import (
	"os"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/activity"
)

func TestTheActivityOfACodexSessionIsWhatItsLatestEventSays(t *testing.T) {
	tests := []struct {
		name   string
		events []string
		want   activity.Reading
		ok     bool
	}{
		{"an agent message", []string{`{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"done"}}`}, activity.Reading{Kind: "text"}, true},
		{"a started item named by its type", []string{`{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"ls"}}`}, activity.Reading{Kind: "tool", Tool: "command_execution"}, true},
		{"a completed item named by its type", []string{`{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"ls"}}`}, activity.Reading{Kind: "tool", Tool: "command_execution"}, true},
		{"a completed turn", []string{`{"type":"turn.completed","usage":{}}`}, activity.Reading{Kind: "result"}, true},
		{"a failed turn", []string{`{"type":"turn.failed","error":{"message":"x"}}`}, activity.Reading{Kind: "error"}, true},
		{"an error event", []string{`{"type":"error","message":"x"}`}, activity.Reading{Kind: "error"}, true},
		{"an error item", []string{`{"type":"item.completed","item":{"id":"item_0","type":"error","message":"x"}}`}, activity.Reading{Kind: "error"}, true},
		{"an item event with no item", []string{`{"type":"item.started"}`}, activity.Reading{}, false},
		{"a line that is no JSON, skipped", []string{`{"type":"turn.completed"}`, "not json"}, activity.Reading{Kind: "result"}, true},
		{"events that show no activity", []string{`{"type":"thread.started","thread_id":"x"}`, `{"type":"turn.started"}`}, activity.Reading{}, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := ActivityIn(test.events)

			if ok != test.ok || got != test.want {
				t.Errorf("ActivityIn(%q) = %+v, %v, want %+v, %v", test.events, got, ok, test.want, test.ok)
			}
		})
	}
}

func TestACodexSessionsActivityIsReadFromItsHoldsEvents(t *testing.T) {
	harness, _, _ := aHarness(t)
	entry := anEntry(t)
	if err := os.WriteFile(harness.Events(entry.ShipID), []byte(`{"type":"turn.completed"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, ok := harness.Activity(entry)

	if !ok || got.Kind != "result" || got.At.IsZero() {
		t.Fatalf("Activity = %+v, %v, want a result", got, ok)
	}
}
