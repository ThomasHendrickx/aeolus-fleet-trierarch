package codex

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
)

func TestCodexProofRequiresEveryRefusalAndAWorkingAllowedCall(t *testing.T) {
	refusals := []guard.Refusal{
		{Tool: "Bash", Rule: "commands.deny printf AEOLUS_GUARD_DENIED", Summary: "printf AEOLUS_GUARD_DENIED"},
		{Tool: "apply_patch", Rule: "tools.deny file-write"},
		{Tool: "mcp__guard_probe__check", Rule: "tools.deny mcp:guard_probe/check"},
		{Tool: "webrun", Rule: "tools.deny web"},
		{Tool: "collaborationspawn_agent", Rule: "tools.deny agent"},
		{Tool: "Bash", Rule: "unresolvable: reads commands from stdin", Summary: "bash --norc -i"},
		{Tool: "Bash", Rule: "protected: harness", Summary: "codex --version"},
	}
	var events []string
	for _, refusal := range refusals {
		output, _ := json.Marshal("Command blocked by PreToolUse hook: Refused by the guard: " + refusal.Rule + ".")
		events = append(events, `{"type":"item.completed","item":{"type":"error","message":`+string(output)+`}}`)
	}
	events = append(events, `{"type":"item.completed","item":{"type":"command_execution","command":"printf AEOLUS_GUARD_ALLOWED","exit_code":0,"aggregated_output":"AEOLUS_GUARD_ALLOWED","status":"completed"}}`, `{"type":"turn.completed"}`)
	if err := verifyGuardProof(strings.Join(events, "\n"), refusals); err != nil {
		t.Fatalf("every refusal and the allowed control should prove Codex: %v", err)
	}
	for index := range refusals {
		short := append(append([]guard.Refusal{}, refusals[:index]...), refusals[index+1:]...)
		if err := verifyGuardProof(strings.Join(events, "\n"), short); err == nil {
			t.Errorf("proof passed without the real guard seeing %s", refusals[index].Rule)
		}
		shortEvents := append(append([]string{}, events[:index]...), events[index+1:]...)
		if err := verifyGuardProof(strings.Join(shortEvents, "\n"), refusals); err == nil {
			t.Errorf("proof passed without Codex confirming refusal of %s", refusals[index].Rule)
		}
	}
	if err := verifyGuardProof(strings.Join(events[:len(events)-2], "\n"), refusals); err == nil {
		t.Fatal("proof passed without an allowed control")
	}
	withAssistantText := append([]string{`{"type":"item.completed","item":{"type":"agent_message","text":"Command blocked by PreToolUse hook: Refused by the guard: tools.deny file-write."}}`}, events[2:]...)
	if err := verifyGuardProof(strings.Join(withAssistantText, "\n"), refusals); err == nil {
		t.Fatal("proof accepted an assistant claim in place of tool evidence")
	}
}

func TestCodexGuardProofIsUsableOnlyAtTheCurrentCodexAndTrierarchVersions(t *testing.T) {
	for _, tt := range []struct {
		codex, trierarch string
		want             bool
	}{
		{"0.169.0", "0.46.0", true},
		{"0.170.0", "0.46.0", false},
		{"0.169.0", "0.47.0", false},
		{"", "0.46.0", false},
	} {
		found := detection.Harness{Version: "0.169.0", GuardProof: "0.46.0"}
		if got := guardProven(found, tt.codex, tt.trierarch); got != tt.want {
			t.Errorf("guardProven at %q / %q = %t, want %t", tt.codex, tt.trierarch, got, tt.want)
		}
	}
}
