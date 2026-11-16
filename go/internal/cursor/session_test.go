package cursor

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestCursorCommandKeepsConfiguredFlagsAndThePromptOutsideOptions(t *testing.T) {
	want := []string{"agent", "--model", "auto", "--output-format=stream-json", "--trust", "--print", "--", "-v"}
	if got := CommandLine([]string{"--model", "auto"}, "-v", ""); !reflect.DeepEqual(got, want) {
		t.Errorf("CommandLine() = %v, want %v", got, want)
	}
	wantResume := []string{"agent", "--force", "--output-format=stream-json", "--trust", "--print", "--resume=chat-1", "--", "hello"}
	if got := CommandLine([]string{"--force"}, "hello", "chat-1"); !reflect.DeepEqual(got, wantResume) {
		t.Errorf("resumed = %v, want %v", got, wantResume)
	}
}

func TestCursorReadsTheChatIDFromCapturedInitBeforeTheResult(t *testing.T) {
	file := "../../../plugins/aeolus-fleet/test/fixtures/cursor/2026.11.13-eacade1/linux/first.events.jsonl"
	if got := LastSessionIn(file); got != "00000000-0000-4000-8000-000000000001" {
		t.Errorf("LastSessionIn() = %q", got)
	}
}

func TestCursorReadsCapturedModelRefusalAndClearsEarlierErrors(t *testing.T) {
	raw, err := os.ReadFile("../../../plugins/aeolus-fleet/test/fixtures/cursor/2026.11.13-eacade1/linux/failed.stderr")
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "events.jsonl")
	if err := os.WriteFile(file, []byte(StderrEvent(strings.TrimSpace(string(raw)))+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := RefusedModelIn(file, "s7-nonexistent-model"); got != "s7-nonexistent-model" {
		t.Errorf("RefusedModelIn() = %q", got)
	}
	if got := RefusedModelIn(file, "auto"); got != "" {
		t.Errorf("other model refused = %q", got)
	}
	if ErrorIn(file) == "" {
		t.Error("ErrorIn() has no refusal cause")
	}
	f, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.WriteString("{\"type\":\"result\",\"is_error\":false}\n")
	_ = f.Close()
	if err != nil {
		t.Fatal(err)
	}
	if got := ErrorIn(file); got != "" {
		t.Errorf("ErrorIn() after success = %q", got)
	}
}
