package guard

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	home       = "/home/crew"
	shipFolder = "/home/crew/ships/shp_1"
	repository = "/home/crew/ships/shp_1/repositories/main"
	stateDir   = "/home/crew/.local/state/aeolus-trierarch/ships/shp_1/guard"
	configFile = "/home/crew/.config/aeolus-trierarch/config.json"
)

var checkedAt = time.Date(2026, 11, 24, 21, 0, 0, 0, time.UTC)

// memorySets is the kept rules a check reads.
type memorySets struct {
	sets []json.RawMessage
	err  error
}

func (m memorySets) Sets(context.Context) ([]json.RawMessage, error) { return m.sets, m.err }

// memoryLinks is the file system's symbolic links, by absolute path.
type memoryLinks map[string]string

func (m memoryLinks) Readlink(_ context.Context, path string) (string, bool, error) {
	target, ok := m[path]
	return target, ok, nil
}

// memoryRefusals is the refusal record.
type memoryRefusals struct {
	mu       sync.Mutex
	refusals []Refusal
}

func (m *memoryRefusals) Append(_ context.Context, refusal Refusal) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.refusals = append(m.refusals, refusal)
	return nil
}

// aSet is one entry of the rules message's sets, its rules the inner block of 4.1.
func aSet(name, commit, rules string) json.RawMessage {
	return json.RawMessage(`{"name":"` + name + `","repository":"fleet/rules","commit":"` + commit +
		`","file":"` + name + `.yaml","floor":false,"rules":` + rules + `}`)
}

// aChecker guards the ship's folder with the given sets.
func aChecker(sets ...json.RawMessage) (Checker, *memoryRefusals) {
	refusals := &memoryRefusals{}
	return Checker{
		Sets:      memorySets{sets: sets},
		Links:     memoryLinks{},
		Refusals:  refusals,
		Now:       func() time.Time { return checkedAt },
		Home:      home,
		Boundary:  Boundary{ShipFolder: shipFolder, Repositories: []string{repository}},
		Protected: ClaudeCodeProtected(home, shipFolder, stateDir, configFile),
	}, refusals
}

// aCall is a Claude Code PreToolUse hook input.
func aCall(tool string, input map[string]any) string {
	encoded, err := json.Marshal(map[string]any{
		"session_id": "s1", "cwd": repository, "hook_event_name": "PreToolUse",
		"tool_name": tool, "tool_input": input,
	})
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func aShellCall(command string) string { return aCall("Bash", map[string]any{"command": command}) }

func check(t *testing.T, checker Checker, call string) Answer {
	t.Helper()
	return checker.Check(context.Background(), io.NopCloser(strings.NewReader(call)))
}

// reason is the refusal the session sees, or "" when the call runs.
func reason(t *testing.T, answer Answer) string {
	t.Helper()
	if answer.ExitCode == 0 {
		if answer.Stdout != "" || answer.Stderr != "" {
			t.Fatalf("an allowed call answered %+v, want no output", answer)
		}
		return ""
	}
	var decision struct {
		HookSpecificOutput struct {
			HookEventName            string `json:"hookEventName"`
			PermissionDecision       string `json:"permissionDecision"`
			PermissionDecisionReason string `json:"permissionDecisionReason"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal([]byte(answer.Stdout), &decision); err != nil {
		t.Fatalf("refusal stdout %q is no hook decision: %v", answer.Stdout, err)
	}
	out := decision.HookSpecificOutput
	if answer.ExitCode != 2 || out.HookEventName != "PreToolUse" || out.PermissionDecision != "deny" ||
		strings.TrimSpace(answer.Stderr) != out.PermissionDecisionReason {
		t.Fatalf("refusal answered %+v, want deny, the reason on stderr and exit 2", answer)
	}
	return out.PermissionDecisionReason
}

func refusedAs(t *testing.T, checker Checker, call, want string) {
	t.Helper()
	if got := reason(t, check(t, checker, call)); got != want {
		t.Errorf("check(%s) refused as %q, want %q", call, got, want)
	}
}

func allowed(t *testing.T, checker Checker, call string) {
	t.Helper()
	if got := reason(t, check(t, checker, call)); got != "" {
		t.Errorf("check(%s) refused as %q, want the call to run", call, got)
	}
}
