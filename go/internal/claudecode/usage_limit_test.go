package claudecode

import (
	"os"
	"testing"
)

func TestAUsageLimitStopKeepsItsReasonResetAndOccurrence(t *testing.T) {
	h, _, _ := aHarness(t)
	entry := anEntry(t)
	tests := []struct{ name, events, occurrence, reason string }{
		{"error result", `{"type":"result","uuid":"stop-1","is_error":true,"result":"You've hit your usage limit. Resets at 18:00 UTC."}`, "stop-1", "You've hit your usage limit. Resets at 18:00 UTC."},
		{"errors list", `{"type":"result","uuid":"stop-2","is_error":true,"errors":["You've hit your limit. Resets at 18:00 UTC."]}`, "stop-2", "You've hit your limit. Resets at 18:00 UTC."},
		{"ordinary error", `{"type":"result","uuid":"stop-3","is_error":true,"result":"Not logged in"}`, "", ""},
		{"ordinary text", `{"type":"assistant","message":{"content":[{"type":"text","text":"You've hit your usage limit"}]}}`, "", ""},
		{"recovered", `{"type":"result","uuid":"stop-1","is_error":true,"result":"You've hit your usage limit"}` + "\n" + `{"type":"result","is_error":false,"result":"Done"}`, "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := os.WriteFile(h.Events(entry.ShipID), []byte(tt.events+"\n"), 0600); err != nil {
				t.Fatal(err)
			}
			occurrence, reason := h.UsageLimit(entry)
			if occurrence != tt.occurrence || reason != tt.reason {
				t.Fatalf("UsageLimit = %q, %q, want %q, %q", occurrence, reason, tt.occurrence, tt.reason)
			}
		})
	}
}
