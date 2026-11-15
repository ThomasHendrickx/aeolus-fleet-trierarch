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

func TestOneUsageLimitOccurrenceSurvivesItsTurnResultButNotALaterError(t *testing.T) {
	h, _, _ := aHarness(t)
	entry := anEntry(t)
	assistant := `{"type":"assistant","uuid":"assistant-1","error":"rate_limit","message":{"content":[{"type":"text","text":"You've hit your usage limit. Resets at 18:00 UTC."}]}}`
	result := `{"type":"result","uuid":"result-1","is_error":true,"errors":["You've hit your usage limit. Resets at 18:00 UTC."]}`
	for _, tt := range []struct{ name, events, occurrence string }{
		{"assistant", assistant, "assistant-1"},
		{"result", assistant + "\n" + result, "assistant-1"},
		{"later error", assistant + "\n" + result + "\n" + `{"type":"result","is_error":true,"result":"Not logged in"}`, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if err := os.WriteFile(h.Events(entry.ShipID), []byte(tt.events+"\n"), 0600); err != nil {
				t.Fatal(err)
			}
			got, _ := h.UsageLimit(entry)
			if got != tt.occurrence {
				t.Fatalf("occurrence = %q, want %q", got, tt.occurrence)
			}
		})
	}
}

func TestARejectedWindowIncludesItsStructuredResetAndAllowedWindowsAreNotStops(t *testing.T) {
	h, _, _ := aHarness(t)
	entry := anEntry(t)
	for _, status := range []string{"allowed", "allowed_warning", "rejected"} {
		t.Run(status, func(t *testing.T) {
			events := `{"type":"rate_limit_event","uuid":"rate-1","rate_limit_info":{"status":"` + status + `","resetsAt":1794765600}}`
			if status == "rejected" {
				events += "\n" + `{"type":"assistant","uuid":"assistant-1","error":"rate_limit","message":{"content":[{"type":"text","text":"You've hit your usage limit"}]}}`
			}
			if err := os.WriteFile(h.Events(entry.ShipID), []byte(events+"\n"), 0600); err != nil {
				t.Fatal(err)
			}
			occurrence, reason := h.UsageLimit(entry)
			if status != "rejected" {
				if occurrence != "" {
					t.Fatalf("%s window counted as a stop: %q", status, reason)
				}
				return
			}
			if occurrence != "rate-1" || reason != "You've hit your usage limit; resets at 2026-11-15T18:00:00.000Z" {
				t.Fatalf("got %q, %q, want rate-1 with reset", occurrence, reason)
			}
		})
	}
}
