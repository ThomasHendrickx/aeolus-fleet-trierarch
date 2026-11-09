package codex

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
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

// TestTheInstalledCodexMergesACrewedServerIntoTheUsersOfTheSameName runs the installed Codex's app server in a throwaway home and Codex home, only
// with AEOLUS_TEST_CODEX=1: a crewed server given as -c over a user's server of the same name keeps the user's headers on an HTTP one, and is refused
// on a stdio one. A session whose configuration names a crewed server is therefore not started; once this fails, the crewed entry may take its place.
func TestTheInstalledCodexMergesACrewedServerIntoTheUsersOfTheSameName(t *testing.T) {
	if os.Getenv("AEOLUS_TEST_CODEX") != "1" {
		t.Skip("runs the installed Codex: only with AEOLUS_TEST_CODEX=1")
	}
	home, codexHome, folder := t.TempDir(), t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	config := `[mcp_servers.company-graph]
command = "sh"
args = ["-c", "exit 0"]

[mcp_servers.notes]
url = "http://127.0.0.1:9/mcp"
http_headers = { "X-User" = "theirs" }
`
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	crewed := func(name string) []string {
		return []string{"-c", "mcp_servers." + name + `={url="http://127.0.0.1:41000/mcp/` + scout + "/" + name + `",bearer_token_env_var="AEOLUS_MCP_TOKEN"}`}
	}
	read := func(overrides []string) (json.RawMessage, error) {
		var said json.RawMessage
		err := AppServer{Program: "codex", Version: "1.2.3"}.talkWith(overrides, func(c *conversation) error {
			answer, err := c.ask("config/read", map[string]string{"cwd": folder})
			said = answer
			return err
		})
		return said, err
	}

	answer, err := read(crewed("notes"))
	var notes struct {
		Config struct {
			McpServers map[string]struct {
				URL         string            `json:"url"`
				HTTPHeaders map[string]string `json:"http_headers"`
			} `json:"mcp_servers"`
		} `json:"config"`
	}
	if err != nil || json.Unmarshal(answer, &notes) != nil || notes.Config.McpServers["notes"].HTTPHeaders["X-User"] != "theirs" {
		t.Errorf("config/read over the HTTP notes = %s, %v, want the crewed url with the user's X-User header merged in", answer, err)
	}
	if _, err := read(crewed("company-graph")); err == nil || !strings.Contains(err.Error(), "url is not supported for stdio") {
		t.Errorf("config/read over the stdio company-graph = %v, want Codex to refuse a url merged into the user's command", err)
	}
}
