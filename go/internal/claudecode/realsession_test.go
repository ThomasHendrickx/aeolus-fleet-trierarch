package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

// TestARealClaudeCodeSessionListsOnlyTheCrewedMCPServerNoneOfTheUsersOrTheFolders runs the installed Claude Code under a hold, in a throwaway
// home, only with AEOLUS_TEST_CLAUDE_CODE=1: it needs no login, as its first event lists its MCP servers before any model call. The user's
// own servers, one named as the crewed one, and the folder's never start.
func TestARealClaudeCodeSessionListsOnlyTheCrewedMCPServerNoneOfTheUsersOrTheFolders(t *testing.T) {
	if os.Getenv("AEOLUS_TEST_CLAUDE_CODE") != "1" {
		t.Skip("runs the installed Claude Code: only with AEOLUS_TEST_CLAUDE_CODE=1")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	started := t.TempDir()
	starts := func(name string) string {
		return `{"type":"stdio","command":"sh","args":["-c","touch ` + filepath.Join(started, name) + `"]}`
	}
	harness, _, _ := aHarness(t)
	entry := anEntry(t)
	entry.McpServers = []string{"company-graph"}
	own := map[string]string{
		filepath.Join(home, ".claude.json"):      `{"mcpServers":{"users-own":` + starts("users-own") + `,"company-graph":` + starts("users-company-graph") + `}}`,
		filepath.Join(entry.Folder, ".mcp.json"): `{"mcpServers":{"folders-own":` + starts("folders-own") + `}}`,
	}
	for path, text := range own {
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// A short folder: a hold's socket path has a limit t.TempDir's names exceed.
	folder, err := os.MkdirTemp("", "sessions")
	if err != nil {
		t.Fatal(err)
	}
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	held := sessions.Runtime{Sessions: folder, Program: []string{program}, Version: "1.2.3", BootedAt: func() time.Time { return time.Now().Add(-time.Hour) }}
	t.Cleanup(func() {
		_ = held.Stop(scout)
		_ = os.RemoveAll(folder)
	})
	harness.Runtime, harness.Sessions = held, folder
	harness.ProxyURL = func() (string, bool) { return "http://127.0.0.1:9", true }

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	var servers []string
	for until := time.Now().Add(60 * time.Second); servers == nil && time.Now().Before(until); time.Sleep(100 * time.Millisecond) {
		events, _ := os.ReadFile(hold.FilesOf(folder, scout).Events)
		for _, line := range strings.Split(string(events), "\n") {
			var event struct {
				Type       string `json:"type"`
				Subtype    string `json:"subtype"`
				McpServers []struct {
					Name string `json:"name"`
				} `json:"mcp_servers"`
			}
			if json.Unmarshal([]byte(line), &event) == nil && event.Type == "system" && event.Subtype == "init" {
				servers = []string{}
				for _, server := range event.McpServers {
					servers = append(servers, server.Name)
				}
			}
		}
	}
	if !slices.Equal(servers, []string{"company-graph"}) {
		t.Errorf("the session lists the MCP servers %q, want company-graph alone", servers)
	}
	_ = held.Stop(scout)
	if names, _ := os.ReadDir(started); len(names) != 0 {
		t.Errorf("%v started, want no server of the user's or the folder's", names)
	}
	// Claude Code keeps its own counters in .claude.json; the servers in it and the folder's file are as they were.
	for path, text := range own {
		var got, want struct {
			McpServers json.RawMessage `json:"mcpServers"`
		}
		if json.Unmarshal([]byte(readText(t, path)), &got) != nil || json.Unmarshal([]byte(text), &want) != nil || !jsonEqual(got.McpServers, want.McpServers) {
			t.Errorf("%s names the MCP servers %s after the session, want them as they were", path, got.McpServers)
		}
	}
}

// jsonEqual is whether two JSON values are the same value, however they are spaced.
func jsonEqual(a, b json.RawMessage) bool {
	var left, right any
	if json.Unmarshal(a, &left) != nil || json.Unmarshal(b, &right) != nil {
		return false
	}
	return reflect.DeepEqual(left, right)
}
