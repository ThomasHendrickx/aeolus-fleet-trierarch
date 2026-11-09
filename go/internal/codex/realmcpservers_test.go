package codex

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

// TestTheInstalledCodexsConfigurationIsListedWithoutStartingOrReachingAServer runs the installed Codex's app server in a throwaway home and
// Codex home, only with AEOLUS_TEST_CODEX=1: it lists the user's and the project's servers and the user's enabled plugin, starts neither stdio server, sends the HTTP one
// no request, and leaves both configuration files as they were.
func TestTheInstalledCodexsConfigurationIsListedWithoutStartingOrReachingAServer(t *testing.T) {
	if os.Getenv("AEOLUS_TEST_CODEX") != "1" {
		t.Skip("runs the installed Codex: only with AEOLUS_TEST_CODEX=1")
	}
	home, codexHome, folder, started := t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
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
	files := map[string]string{
		filepath.Join(codexHome, "config.toml"): `[mcp_servers.users-own]
command = "sh"
args = ["-c", "touch ` + filepath.Join(started, "users-own") + `"]

[mcp_servers."dot.ted"]
url = "` + server.URL + `/mcp"

[projects."` + folder + `"]
trust_level = "trusted"

[plugins."withmcp@probe-market"]
enabled = true
`,
		filepath.Join(folder, ".codex", "config.toml"): `[mcp_servers.projects-own]
command = "sh"
args = ["-c", "touch ` + filepath.Join(started, "projects-own") + `"]
`,
	}
	for path, text := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	configured, err := AppServer{Program: "codex", Version: "1.2.3"}.ConfiguredFor(folder, nil)

	slices.Sort(configured.McpServers)
	if want := []string{"dot.ted", "projects-own", "users-own"}; err != nil || !slices.Equal(configured.McpServers, want) || !slices.Equal(configured.Plugins, []string{"withmcp@probe-market"}) {
		t.Fatalf("ConfiguredFor = %+v, %v, want the servers %q and the plugin withmcp@probe-market", configured, err, want)
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
}
