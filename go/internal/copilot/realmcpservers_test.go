package copilot

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sync/atomic"
	"testing"
)

// TestTheInstalledCopilotsServersAreListedWithoutStartingOrReachingOne runs the installed Copilot in a throwaway home and COPILOT_HOME, only
// with AEOLUS_TEST_COPILOT=1: it lists the user's and the trusted workspace's servers, starts neither stdio server, sends the HTTP one no
// request, and leaves COPILOT_HOME's files and the workspace's as they were.
func TestTheInstalledCopilotsServersAreListedWithoutStartingOrReachingOne(t *testing.T) {
	if os.Getenv("AEOLUS_TEST_COPILOT") != "1" {
		t.Skip("runs the installed Copilot: only with AEOLUS_TEST_COPILOT=1")
	}
	home, folder, started := t.TempDir(), t.TempDir(), t.TempDir()
	copilotHome := filepath.Join(home, ".copilot-work")
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	if err := exec.Command("git", "-C", folder, "init", "-q").Run(); err != nil {
		t.Fatal(err)
	}
	starts := func(name string) string {
		return `{"type":"local","command":"sh","args":["-c","touch ` + filepath.Join(started, name) + `"],"tools":["*"]}`
	}
	files := map[string]string{
		filepath.Join(copilotHome, "mcp-config.json"): `{"mcpServers":{"users-own":` + starts("users-own") + `,"http-own":{"type":"http","url":"` + server.URL + `/mcp","tools":["*"]}}}`,
		filepath.Join(copilotHome, "config.json"):     `{"trusted_folders":["` + folder + `"]}`,
		filepath.Join(folder, ".mcp.json"):            `{"mcpServers":{"workspaces-own":` + starts("workspaces-own") + `}}`,
	}
	for path, text := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	names, err := McpList{Program: "copilot", CopilotHome: copilotHome}.McpServersIn(folder)

	slices.Sort(names)
	if want := []string{"http-own", "users-own", "workspaces-own"}; err != nil || !slices.Equal(names, want) {
		t.Fatalf("McpServersIn = %q, %v, want %q", names, err, want)
	}
	if got := requests.Load(); got != 0 {
		t.Errorf("the HTTP server got %d requests, want none", got)
	}
	if entries, _ := os.ReadDir(started); len(entries) != 0 {
		t.Errorf("%v started, want no server", entries)
	}
	for path, text := range files {
		if got, _ := os.ReadFile(path); string(got) != text {
			t.Errorf("%s = %q after the listing, want it as it was", path, got)
		}
	}
	if entries, _ := os.ReadDir(copilotHome); len(entries) != 2 {
		t.Errorf("COPILOT_HOME holds %v after the listing, want only its two files", entries)
	}
}
