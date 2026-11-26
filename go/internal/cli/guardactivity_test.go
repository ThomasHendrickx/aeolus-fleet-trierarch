package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestGuardToolCallsKeepEveryVerdictWhileTheSessionRuns(t *testing.T) {
	machine, at, folder := aGuardedShip(t, noPublishRules)
	when := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	machine.Now = func() time.Time { return when }
	for _, call := range []struct {
		tool  string
		input map[string]any
		code  int
	}{
		{"Bash", map[string]any{"command": "npm test"}, 0},
		{"Bash", map[string]any{"command": "npm publish"}, 2},
		{"Write", map[string]any{"file_path": "/outside/private-filename", "content": "test tool content"}, 2},
		{"Read", map[string]any{"file_path": "README.md"}, 0},
	} {
		_, _, code := guardCheck(machine, guardedShip, aHookCall(t, folder, call.tool, call.input))
		if code != call.code {
			t.Fatalf("guard check %s = %d, want %d", call.tool, code, call.code)
		}
	}

	path := filepath.Join(at.Guard, guardedShip, "tool-calls.jsonl")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	type activity struct {
		At     time.Time `json:"at"`
		Tool   string    `json:"tool"`
		Result string    `json:"result"`
		Reason string    `json:"reason"`
	}
	var got []activity
	for line := range strings.SplitSeq(strings.TrimSpace(string(data)), "\n") {
		var record activity
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		got = append(got, record)
	}
	want := []activity{
		{when, "Bash", "allowed", ""},
		{when, "Bash", "refused", "commands.deny"},
		{when, "Write", "refused", "outside the boundary"},
		{when, "Read", "allowed", ""},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("live tool calls = %+v, want %+v", got, want)
	}
	for _, input := range []string{"npm test", "npm publish", "private-filename", "test tool content", "README.md"} {
		if strings.Contains(string(data), input) {
			t.Fatalf("the live tool calls include the input %q", input)
		}
	}
}
