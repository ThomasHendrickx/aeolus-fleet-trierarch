package copilot

import (
	"os"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/activity"
)

func TestTheActivityOfACopilotSessionIsWhatItsLatestEventSays(t *testing.T) {
	tests := []struct {
		name   string
		events []string
		want   activity.Reading
		ok     bool
	}{
		{"a tool execution starting, with the tool", []string{`{"type":"tool.execution_start","data":{"toolName":"bash","arguments":{"command":"sleep 40"}}}`}, activity.Reading{Kind: "tool", Tool: "bash"}, true},
		{"a tool execution starting with no name", []string{`{"type":"tool.execution_start","data":{}}`}, activity.Reading{Kind: "tool"}, true},
		{"a tool execution completed", []string{`{"type":"tool.execution_complete","data":{"toolName":"bash"}}`}, activity.Reading{Kind: "result"}, true},
		{"the session's result", []string{`{"type":"result","exitCode":0}`}, activity.Reading{Kind: "result"}, true},
		{"the assistant saying something", []string{`{"type":"assistant.message","data":{"content":"OK"}}`}, activity.Reading{Kind: "text"}, true},
		{"a session error", []string{`{"type":"session.error","data":{"message":"x"}}`}, activity.Reading{Kind: "error"}, true},
		{"an assistant message that only asked for tools", []string{`{"type":"session.mcp_server_status_changed","data":{}}`, `{"type":"assistant.message","data":{"content":""}}`}, activity.Reading{}, false},
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

func TestACopilotSessionsActivityIsReadFromItsHoldsEvents(t *testing.T) {
	harness, _ := aHarness(t)
	entry := anEntry(t)
	if err := os.WriteFile(harness.Events(entry.ShipID), []byte(`{"type":"session.error","data":{}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, ok := harness.Activity(entry)

	if !ok || got.Kind != "error" || got.At.IsZero() {
		t.Fatalf("Activity = %+v, %v, want an error", got, ok)
	}
}
