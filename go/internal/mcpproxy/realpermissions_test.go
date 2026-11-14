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
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/permissions"
)

// TestARealClaudeCodeSessionHidesThePermissionToolAndListsTheArgoDenial uses the
// installed harness and a deterministic model server, without an account or key.
func TestARealClaudeCodeSessionHidesThePermissionToolAndListsTheArgoDenial(t *testing.T) {
	realPermissionCall(t, false)
}

func TestARealClaudeCodePermissionWaitKeepsProgressPastTheSilentHTTPLimit(t *testing.T) {
	realPermissionCall(t, true)
}

// The real harness must hold an HTTP permission call past its 60-second silent
// limit. Only the injected permission limit is shortened; progress stays 20s.
type permissionTryClock struct{}

func (permissionTryClock) NewTimer(time.Duration) permissions.Timer {
	return permissions.SystemClock{}.NewTimer(65 * time.Second)
}

func realPermissionCall(t *testing.T, isPerson bool) {
	if os.Getenv("AEOLUS_TEST_CLAUDE_CODE") != "1" {
		t.Skip("runs the installed Claude Code: AEOLUS_TEST_CLAUDE_CODE=1")
	}
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	aSession(t, sessions, scout, os.Getpid(), Access{Token: "test-session", Servers: []string{permissions.Server}})
	var reads atomic.Int32
	var mu sync.Mutex
	report := permissions.Report{State: "working", Note: "before", Revision: "before"}
	fleet := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer test-crew" {
			http.Error(w, "unexpected fleet call", 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/ship/whoami":
			reads.Add(1)
			name := "argo"
			if isPerson {
				name = "thomas"
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"ownerShipId": "shp_01m6jyczpnpp5c0vxh54c966cz", "ownerName": name})
		case "/api/v1/ship/reportLog":
			_ = json.NewEncoder(w).Encode(map[string]any{"report": report})
		case "/api/v1/ship/report":
			if json.NewDecoder(r.Body).Decode(&report) != nil {
				http.Error(w, "invalid report", 400)
				return
			}
			report.Revision = "waiting"
			fmt.Fprint(w, `{}`)
		default:
			http.Error(w, "unexpected fleet call", 400)
		}
	}))
	defer fleet.Close()
	channelFolder, err := os.MkdirTemp("", "permissions-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(channelFolder) })
	socket := filepath.Join(channelFolder, "p.sock")
	channel, err := permissions.Listen(socket, func(ship, token string) bool { return AuthorizesPermission(sessions, ship, token) }, permissions.Fleet{URL: fleet.URL, Clock: permissionTryClock{}, TokenOf: func(string) string { return "test-crew" }})
	if err != nil {
		t.Fatal(err)
	}
	defer channel.Close()
	proxy := httptest.NewServer(Proxy{Sessions: sessions, PermissionCalls: NewPermissionCalls(), PermissionWait: func(ctx context.Context, ship, token string, request permissions.Request) permissions.Decision {
		return (permissions.Client{Socket: socket, Token: token}).Ask(ctx, ship, request)
	}})
	defer proxy.Close()
	var messages atomic.Int32
	var exposed atomic.Bool
	vendor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/messages") {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"input_tokens":1}`)
			return
		}
		var request struct{ Tools []struct{ Name string } }
		_ = json.NewDecoder(r.Body).Decode(&request)
		for _, tool := range request.Tools {
			if tool.Name == "mcp__aeolus-permissions__ask" {
				exposed.Store(true)
			}
		}
		block := map[string]any{"type": "text", "text": "The action was denied."}
		stop := "end_turn"
		if messages.Add(1) == 1 {
			block = map[string]any{"type": "tool_use", "id": "toolu_permission_test", "name": "Bash", "input": map[string]any{"command": "printf forbidden > denied.txt", "description": "Write the test file"}}
			stop = "tool_use"
		}
		delta := map[string]any{"type": "text_delta", "text": "The action was denied."}
		if stop == "tool_use" {
			input, _ := json.Marshal(block["input"])
			block["input"] = map[string]any{}
			delta = map[string]any{"type": "input_json_delta", "partial_json": string(input)}
		} else {
			block["text"] = ""
		}
		w.Header().Set("Content-Type", "text/event-stream")
		events := []struct {
			name  string
			value any
		}{
			{"message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": "msg_test", "type": "message", "role": "assistant", "content": []any{}, "model": "claude-sonnet-4-6", "stop_reason": nil, "usage": map[string]int{"input_tokens": 1, "output_tokens": 0}}}},
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
	defer vendor.Close()
	configuration := filepath.Join(root, "mcp.json")
	text, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{permissions.Server: map[string]any{"type": "http", "url": proxy.URL + PathOf(scout, permissions.Server), "headers": map[string]string{"Authorization": "Bearer test-session"}}}})
	if err := os.WriteFile(configuration, text, 0o600); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(root, "claude")
	if err := os.MkdirAll(config, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(config, ".claude.json"), []byte(`{"hasCompletedOnboarding":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "claude", "-p", "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-4-6", "--setting-sources", "", "--strict-mcp-config", "--permission-mode", "default", "--permission-prompt-tool", "mcp__aeolus-permissions__ask", "--mcp-config", configuration, "--", "Run the requested Bash action once.")
	command.Dir = root
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(name, "ANTHROPIC_") && !strings.HasPrefix(name, "CLAUDE_") && name != "CLAUDECODE" {
			command.Env = append(command.Env, entry)
		}
	}
	command.Env = append(command.Env, "CLAUDE_CONFIG_DIR="+config, "ANTHROPIC_BASE_URL="+vendor.URL, "ANTHROPIC_API_KEY=test-model-key", "ENABLE_CLAUDEAI_MCP_SERVERS=false", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("Claude Code: %v\n%s", err, output)
	}
	if reads.Load() != 1 {
		t.Fatalf("whoami reads = %d, want 1; output %s", reads.Load(), output)
	}
	if exposed.Load() {
		t.Fatal("permission tool was exposed in the model's tool list")
	}
	var denied bool
	for _, line := range strings.Split(string(output), "\n") {
		var result struct {
			Type              string
			PermissionDenials []struct {
				ToolName string `json:"tool_name"`
			} `json:"permission_denials"`
		}
		if json.Unmarshal([]byte(line), &result) == nil && result.Type == "result" {
			for _, denial := range result.PermissionDenials {
				denied = denied || denial.ToolName == "Bash"
			}
		}
	}
	message := "this ship's owner is argo: nobody is asked"
	if isPerson {
		message = "not answered in 30 minutes; the question was withdrawn"
	}
	if !denied || !strings.Contains(string(output), message) {
		t.Fatalf("no permission denial %q: %s", message, output)
	}
	mu.Lock()
	restored := report.State == "working" && report.Note == "before"
	mu.Unlock()
	if !restored {
		t.Fatal("entry report was not restored")
	}

	if _, err := os.Stat(filepath.Join(root, "denied.txt")); !os.IsNotExist(err) {
		t.Fatalf("denied action created the file, stat = %v", err)
	}
}
