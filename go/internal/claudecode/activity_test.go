package claudecode

import (
	"os"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/activity"
)

func TestTheActivityOfAClaudeCodeSessionIsWhatItsLatestEventSays(t *testing.T) {
	assistant := func(content string) string {
		return `{"type":"assistant","message":{"role":"assistant","content":[` + content + `]}}`
	}
	tests := []struct {
		name   string
		events []string
		want   activity.Reading
		ok     bool
	}{
		{"a tool call, with the tool", []string{assistant(`{"type":"text","text":"Running it."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}`)}, activity.Reading{Kind: "tool", Tool: "Bash"}, true},
		{"a tool call with no name", []string{assistant(`{"type":"tool_use","id":"t1"}`)}, activity.Reading{Kind: "tool"}, true},
		{"text", []string{assistant(`{"type":"text","text":"Done."}`)}, activity.Reading{Kind: "text"}, true},
		{"a tool result coming back", []string{`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}`}, activity.Reading{Kind: "result"}, true},
		{"a turn that ended well", []string{`{"type":"result","subtype":"success","is_error":false,"result":"Done."}`}, activity.Reading{Kind: "result"}, true},
		{"a turn that ended in an error", []string{`{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Not logged in"}`}, activity.Reading{Kind: "error"}, true},
		{"events that are no activity skipped", []string{assistant(`{"type":"text","text":"Hi"}`), `{"type":"system","subtype":"init"}`, "not json", `{"type":"control_response"}`}, activity.Reading{Kind: "text"}, true},
		{"a user line that is no tool result", []string{`{"type":"user","message":{"role":"user","content":"hello"}}`}, activity.Reading{}, false},
		{"only an init", []string{`{"type":"system","subtype":"init"}`}, activity.Reading{}, false},
		{"no events", nil, activity.Reading{}, false},
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

func TestAClaudeCodeSessionsActivityIsReadFromItsHoldsEvents(t *testing.T) {
	harness, _, _ := aHarness(t)
	entry := anEntry(t)
	if err := os.WriteFile(harness.Events(entry.ShipID), []byte(`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, ok := harness.Activity(entry)

	if !ok || got.Kind != "tool" || got.Tool != "Bash" || got.At.IsZero() {
		t.Fatalf("Activity = %+v, %v, want a Bash tool call", got, ok)
	}
}
