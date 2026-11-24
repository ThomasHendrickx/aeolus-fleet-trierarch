package claudecode

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guardfile"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/state"
)

// The guard as the installed Claude Code runs it (aeolus-fleet docs/design/guard, sections 4.6 and 4.7): the settings the trierarch
// writes, with the trierarch built from this tree as guard check, under a deterministic model server that asks for one Bash call, so
// it needs no account or key. Only with AEOLUS_TEST_CLAUDE_CODE=1. A call runs when its marker file appears.

const realGuardShip = "shp_01m6jyczpnpp5c0vxh54c966cy"

// noTouch are kept rules with one set that denies touch.
const noTouch = `[{"name":"no-touch","repository":"fleet/rules","commit":"8d41e07aa1","file":"no-touch.yaml","floor":false,"rules":{"commands":{"deny":[{"command":"touch"}]}}}]`

func TestARealClaudeCodeSessionRunsACallTheGuardLets(t *testing.T) {
	session := aRealGuardedSession(t, "[]")

	result := session.run(t, session.program)

	if !result.ran {
		t.Fatalf("the call did not run: %s", result.output)
	}
}

func TestARealClaudeCodeSessionDoesNotRunACallTheGuardDeniesAndShowsItsRule(t *testing.T) {
	session := aRealGuardedSession(t, noTouch)

	result := session.run(t, session.program)

	if result.ran || !strings.Contains(result.output, "Refused by the guard: commands.deny touch, in no-touch @ 8d41e07.") {
		t.Fatalf("ran %v, want the call refused with its rule: %s", result.ran, result.output)
	}
	refusals, err := os.ReadFile(filepath.Join(guardfile.Folder(session.at.Guard, realGuardShip), "refusals.jsonl"))
	if err != nil || !strings.Contains(string(refusals), `"rule":"commands.deny touch"`) {
		t.Fatalf("refusals %s, %v, want the refusal kept", refusals, err)
	}
}

func TestARealClaudeCodeSessionDoesNotRunACallWhenTheGuardCrashes(t *testing.T) {
	for name, script := range map[string]string{
		// A Go panic the guard does not recover exits 2 with its trace on stderr.
		"panic": "echo 'panic: runtime error' >&2\nexit 2\n",
		// Killed, as when the machine runs out of memory.
		"killed": "kill -9 $$\n",
		// Exits with an error before it answers.
		"failed": "exit 1\n",
	} {
		t.Run(name, func(t *testing.T) {
			session := aRealGuardedSession(t, "[]")
			crashing := filepath.Join(t.TempDir(), "aeolus-trierarch")
			if err := os.WriteFile(crashing, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
				t.Fatal(err)
			}

			result := session.run(t, crashing)

			if result.ran {
				t.Fatalf("the call ran while the guard crashed: %s", result.output)
			}
		})
	}
}

func TestARealClaudeCodeSessionDoesNotRunACallWhenTheGuardsProgramIsGone(t *testing.T) {
	session := aRealGuardedSession(t, "[]")

	result := session.run(t, filepath.Join(t.TempDir(), "gone", "aeolus-trierarch"))

	if result.ran {
		t.Fatalf("the call ran without its guard: %s", result.output)
	}
}

func TestARealClaudeCodeSessionDoesNotRunACallWhenTheGuardMissesItsDeadline(t *testing.T) {
	session := aRealGuardedSession(t, noTouch)
	// A refusal kept through a pipe no one reads hangs until the guard's own deadline answers.
	if err := os.MkdirAll(guardfile.Folder(session.at.Guard, realGuardShip), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(guardfile.Folder(session.at.Guard, realGuardShip), "refusals.jsonl"), 0o600); err != nil {
		t.Fatal(err)
	}

	result := session.run(t, session.program)

	if result.ran || !strings.Contains(result.output, "Refused by the guard: guard failed: deadline.") {
		t.Fatalf("ran %v, want the call refused at the guard's deadline: %s", result.ran, result.output)
	}
}

// realGuardedSession is a ship crewed in its folder with its rules kept, and the trierarch built from this tree.
type realGuardedSession struct {
	home    string
	at      paths.Paths
	folder  string
	program string
}

func aRealGuardedSession(t *testing.T, sets string) realGuardedSession {
	t.Helper()
	if os.Getenv("AEOLUS_TEST_CLAUDE_CODE") != "1" {
		t.Skip("runs the installed Claude Code: only with AEOLUS_TEST_CLAUDE_CODE=1")
	}
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	at := paths.Of(home, "")
	folder := filepath.Join(at.Ships, realGuardShip, "repositories")
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	crewed := reconciler.Empty()
	crewed.Entries[realGuardShip] = reconciler.Entry{ShipID: realGuardShip, SettingsVersion: 1, Harness: "claude-code", State: "running", Folder: folder, ShipFolder: filepath.Join(at.Ships, realGuardShip)}
	if err := (state.File{Path: at.State}).Save(crewed); err != nil {
		t.Fatal(err)
	}
	rules := `{"fleetId":"flt_01m3tb1zgr5h2ffee12xnch8sv","pluginShipId":"shp_01m6jyczpnpp5c0vxh54c966cz","shipId":"` + realGuardShip + `","settingsVersion":1,"sets":` + sets + `}`
	if err := (guardfile.Store{Guards: at.Guard}).Write(context.Background(), realGuardShip, []byte(rules)); err != nil {
		t.Fatal(err)
	}
	return realGuardedSession{home: home, at: at, folder: folder, program: builtTrierarch(t)}
}

// builtTrierarch is the trierarch built from this tree.
func builtTrierarch(t *testing.T) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	program := filepath.Join(t.TempDir(), "aeolus-trierarch")
	build := exec.Command("go", "build", "-o", program, "./cmd/aeolus-trierarch")
	build.Dir = filepath.Join(filepath.Dir(file), "..", "..")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, output)
	}
	return program
}

type realGuardResult struct {
	ran    bool
	output string
}

// run starts Claude Code in the ship's folder with the guard settings the trierarch writes for the program, its model asking for one
// `touch` in the folder.
func (s realGuardedSession) run(t *testing.T, program string) realGuardResult {
	t.Helper()
	marker := filepath.Join(s.folder, "ran")
	model := aBashModel(t, "touch "+marker)
	harness := Harness{Program: program, Guards: s.at.Guard}
	settings, err := harness.writeGuardSettings(realGuardShip, nil)
	if err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(s.home, ".claude")
	if err := os.MkdirAll(config, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(config, ".claude.json"), []byte(`{"hasCompletedOnboarding":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "claude", "-p", "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-4-6", "--setting-sources", "", "--dangerously-skip-permissions", "--settings", settings, "--", "Run the requested Bash action once.")
	command.Dir = s.folder
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(name, "ANTHROPIC_") && !strings.HasPrefix(name, "CLAUDE_") && name != "CLAUDECODE" && name != "HOME" && !strings.HasPrefix(name, "AEOLUS_") {
			command.Env = append(command.Env, entry)
		}
	}
	command.Env = append(command.Env, "HOME="+s.home, "CLAUDE_CONFIG_DIR="+config, "ANTHROPIC_BASE_URL="+model.URL, "ANTHROPIC_API_KEY=test-model-key", "ENABLE_CLAUDEAI_MCP_SERVERS=false", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("Claude Code: %v\n%s", err, output)
	}
	_, statErr := os.Stat(marker)
	return realGuardResult{ran: statErr == nil, output: string(output)}
}

// aBashModel is a model server that asks for the Bash command until it gets a tool result, then ends its turn.
func aBashModel(t *testing.T, bash string) *httptest.Server {
	t.Helper()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/messages") {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"input_tokens":1}`)
			return
		}
		var request struct{ Messages []json.RawMessage }
		_ = json.NewDecoder(r.Body).Decode(&request)
		isAnswered := false
		for _, message := range request.Messages {
			isAnswered = isAnswered || strings.Contains(string(message), "tool_result")
		}
		block := map[string]any{"type": "text", "text": ""}
		delta := map[string]any{"type": "text_delta", "text": "Done."}
		stop := "end_turn"
		if !isAnswered {
			input, _ := json.Marshal(map[string]any{"command": bash, "description": "Run the requested action"})
			block = map[string]any{"type": "tool_use", "id": fmt.Sprintf("toolu_guard_%d", calls.Add(1)), "name": "Bash", "input": map[string]any{}}
			delta = map[string]any{"type": "input_json_delta", "partial_json": string(input)}
			stop = "tool_use"
		}
		w.Header().Set("Content-Type", "text/event-stream")
		events := []struct {
			name  string
			value any
		}{
			{"message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": "msg_guard", "type": "message", "role": "assistant", "content": []any{}, "model": "claude-sonnet-4-6", "stop_reason": nil, "usage": map[string]int{"input_tokens": 1, "output_tokens": 0}}}},
			{"content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": block}},
			{"content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": delta}},
			{"content_block_stop", map[string]any{"type": "content_block_stop", "index": 0}},
			{"message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": stop, "stop_sequence": nil}, "usage": map[string]int{"output_tokens": 1}}},
			{"message_stop", map[string]string{"type": "message_stop"}},
		}
		for _, event := range events {
			text, _ := json.Marshal(event.value)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.name, text)
		}
	}))
	t.Cleanup(server.Close)
	return server
}
