package mcpproxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/permissions"
)

type ruleOwner struct{ asks atomic.Int32 }

func (o *ruleOwner) Owner(context.Context, string) (permissions.Owner, error) {
	return permissions.Owner{IsPerson: true, ID: "owner"}, nil
}
func (o *ruleOwner) Ask(context.Context, string, permissions.Request) (string, error) {
	o.asks.Add(1)
	return "question", nil
}
func (o *ruleOwner) Withdraw(context.Context, string, string) error { return nil }
func (o *ruleOwner) Receive(context.Context, string, string) (permissions.Reply, error) {
	return permissions.Reply{Answer: permissions.Answer{Option: 2}, SenderID: "owner", Matches: true}, nil
}
func (o *ruleOwner) Finish(context.Context, string, permissions.Reply, bool) error { return nil }
func (o *ruleOwner) ReadReport(context.Context, string) (permissions.Report, error) {
	return permissions.Report{State: "working"}, nil
}
func (o *ruleOwner) WriteReport(context.Context, string, permissions.Report) error { return nil }

func TestARealClaudeCodeSessionRuleNamesTheExactPathAndEndsWithTheProcess(t *testing.T) {
	realSessionRule(t, "Write", 2)
}
func TestARealClaudeCodeBashRedirectionAsksAgainDespiteTheSessionRule(t *testing.T) {
	realSessionRule(t, "Bash", 3)
}

func realSessionRule(t *testing.T, tool string, wantAsks int32, names ...string) {
	name := "a.txt"
	otherName := "b.txt"
	if len(names) > 0 {
		name = names[0]
		otherName = strings.Replace(name, "?", "Q", 1)
	}
	if os.Getenv("AEOLUS_TEST_CLAUDE_CODE") != "1" {
		t.Skip("runs the installed Claude Code: AEOLUS_TEST_CLAUDE_CODE=1")
	}
	root := t.TempDir()
	owner := &ruleOwner{}
	service := permissions.Service{Owners: owner, Questions: owner, Reports: owner, Clock: permissions.SystemClock{}}
	sessions := filepath.Join(root, "sessions")
	aSession(t, sessions, scout, os.Getpid(), Access{Token: "test-session", Servers: []string{permissions.Server}})
	proxy := httptest.NewServer(Proxy{Sessions: sessions, PermissionCalls: NewPermissionCalls(), PermissionWait: func(ctx context.Context, ship, _ string, r permissions.Request) permissions.Decision {
		decision := service.Ask(ctx, ship, r)
		data, _ := json.Marshal(decision)
		t.Logf("permission result: %s", data)
		return decision
	}})
	defer proxy.Close()
	var calls atomic.Int32
	vendor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/messages") {
			fmt.Fprint(w, `{"input_tokens":1}`)
			return
		}
		call := calls.Add(1)
		if call > 3 {
			ruleModelReply(w, call, "", nil)
			return
		}
		path := filepath.Join(root, name)
		if call == 3 {
			path = filepath.Join(root, otherName)
		}
		input := map[string]any{"file_path": path, "content": fmt.Sprint(call)}
		if tool == "Bash" {
			input = map[string]any{"command": "echo test > a.txt"}
			if call == 3 {
				input["command"] = "echo other > b.txt"
			}
		}
		ruleModelReply(w, call, tool, input)
	}))
	defer vendor.Close()
	config := filepath.Join(root, "claude")
	if err := os.MkdirAll(config, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(config, ".claude.json"), []byte(`{"hasCompletedOnboarding":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	mcp := filepath.Join(root, "mcp.json")
	data, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{permissions.Server: map[string]any{"type": "http", "url": proxy.URL + PathOf(scout, permissions.Server), "headers": map[string]string{"Authorization": "Bearer test-session"}}}})
	if err := os.WriteFile(mcp, data, 0600); err != nil {
		t.Fatal(err)
	}
	for _, restart := range []bool{false, true} {
		calls.Store(0)
		before := owner.asks.Load()
		args := []string{"-p", "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-4-6", "--setting-sources", "", "--strict-mcp-config", "--permission-mode", "default", "--permission-prompt-tool", "mcp__aeolus-permissions__ask", "--mcp-config", mcp}
		if restart {
			args = append(args, "--continue")
		}
		args = append(args, "--", "Do the three requested actions.")
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		command := exec.CommandContext(ctx, "claude", args...)
		command.Dir = root
		for _, entry := range os.Environ() {
			name, _, _ := strings.Cut(entry, "=")
			if !strings.HasPrefix(name, "ANTHROPIC_") && !strings.HasPrefix(name, "CLAUDE_") && name != "CLAUDECODE" {
				command.Env = append(command.Env, entry)
			}
		}
		command.Env = append(command.Env, "CLAUDE_CONFIG_DIR="+config, "ANTHROPIC_BASE_URL="+vendor.URL, "ANTHROPIC_API_KEY=test-model-key", "ENABLE_CLAUDEAI_MCP_SERVERS=false", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1")
		output, err := command.CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("Claude Code restart=%v: %v: %s", restart, err, output)
		}
		if got := owner.asks.Load() - before; got != wantAsks {
			t.Fatalf("permission asks tool=%s restart=%v: got %d want %d\n%s", tool, restart, got, wantAsks, output)
		}
		if _, err := os.Stat(filepath.Join(root, otherName)); err != nil {
			t.Fatalf("last allowed action did not run: %v\n%s", err, output)
		}
	}
}

// The model is a deterministic system boundary; the installed harness executes
// its real tools and applies its actual permission matching rules.
func ruleModelReply(w http.ResponseWriter, call int32, tool string, input map[string]any) {
	block := map[string]any{"type": "text", "text": ""}
	delta := map[string]any{"type": "text_delta", "text": "Done."}
	stop := "end_turn"
	if tool != "" {
		stop = "tool_use"
		data, _ := json.Marshal(input)
		block = map[string]any{"type": "tool_use", "id": fmt.Sprintf("toolu_rule_%d", call), "name": tool, "input": map[string]any{}}
		delta = map[string]any{"type": "input_json_delta", "partial_json": string(data)}
	}
	w.Header().Set("Content-Type", "text/event-stream")
	for _, event := range []struct {
		name  string
		value any
	}{
		{"message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": fmt.Sprintf("msg_rule_%d", call), "type": "message", "role": "assistant", "content": []any{}, "model": "claude-sonnet-4-6", "stop_reason": nil, "usage": map[string]int{"input_tokens": 1, "output_tokens": 0}}}},
		{"content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": block}},
		{"content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": delta}},
		{"content_block_stop", map[string]any{"type": "content_block_stop", "index": 0}},
		{"message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": stop, "stop_sequence": nil}, "usage": map[string]int{"output_tokens": 1}}},
		{"message_stop", map[string]string{"type": "message_stop"}},
	} {
		data, _ := json.Marshal(event.value)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.name, data)
	}
}

func TestARealClaudeCodeSessionRuleEscapesLiteralPathPatternCharacters(t *testing.T) {
	realSessionRule(t, "Write", 2, "a[1]*?.txt")
}
