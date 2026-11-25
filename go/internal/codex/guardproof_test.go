package codex

import (
	"encoding/json"
	"os"
	"path/filepath"
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
	var transcripts []string
	for _, refusal := range refusals {
		output, _ := json.Marshal("Command blocked by PreToolUse hook: Refused by the guard: " + refusal.Rule + ".")
		transcripts = append(transcripts, `{"type":"response_item","payload":{"type":"custom_tool_call_output","output":`+string(output)+`}}`)
	}
	events := []string{`{"type":"item.completed","item":{"type":"command_execution","command":"printf AEOLUS_GUARD_ALLOWED","exit_code":0,"aggregated_output":"AEOLUS_GUARD_ALLOWED","status":"completed"}}`, `{"type":"turn.completed"}`}
	if err := verifyGuardProof(strings.Join(events, "\n"), strings.Join(transcripts, "\n"), refusals); err != nil {
		t.Fatalf("every refusal and the allowed control should prove Codex: %v", err)
	}
	for index := range refusals {
		short := append(append([]guard.Refusal{}, refusals[:index]...), refusals[index+1:]...)
		if err := verifyGuardProof(strings.Join(events, "\n"), strings.Join(transcripts, "\n"), short); err == nil {
			t.Errorf("proof passed without the real guard seeing %s", refusals[index].Rule)
		}
		shortTranscript := append(append([]string{}, transcripts[:index]...), transcripts[index+1:]...)
		if err := verifyGuardProof(strings.Join(events, "\n"), strings.Join(shortTranscript, "\n"), refusals); err == nil {
			t.Errorf("proof passed without Codex confirming refusal of %s", refusals[index].Rule)
		}
	}
	if err := verifyGuardProof(events[1], strings.Join(transcripts, "\n"), refusals); err == nil {
		t.Fatal("proof passed without an allowed control")
	}
	withAssistantText := append([]string{`{"type":"response_item","payload":{"type":"message","role":"assistant","content":"Command blocked by PreToolUse hook: Refused by the guard: tools.deny file-write."}}`}, transcripts[2:]...)
	if err := verifyGuardProof(strings.Join(events, "\n"), strings.Join(withAssistantText, "\n"), refusals); err == nil {
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

func TestCodexProofSelectsTheTranscriptOfItsOwnTurn(t *testing.T) {
	home := t.TempDir()
	folder := filepath.Join(home, "sessions", "2026", "11", "25")
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, text := range map[string]string{"rollout-2026-11-25-probe-thread.jsonl": "probe", "rollout-2026-11-25-other-thread.jsonl": "other"} {
		if err := os.WriteFile(filepath.Join(folder, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	events := `{"type":"thread.started","thread_id":"probe-thread"}`
	text, err := guardProbeTranscript(home, events)
	if err != nil || text != "probe" {
		t.Fatalf("selected transcript = %q, %v, want the probe thread's transcript", text, err)
	}
}
