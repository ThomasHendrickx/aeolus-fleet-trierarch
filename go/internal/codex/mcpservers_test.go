package codex

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// anAppServerReadingConfig is a stand-in for `codex app-server` answering config/read with the configuration given, noting each line it is sent; it touches the marker file if it is asked anything that would start or reach a server.
func anAppServerReadingConfig(t *testing.T, config string) (string, string, string) {
	t.Helper()
	folder := t.TempDir()
	said, reached := filepath.Join(folder, "said.jsonl"), filepath.Join(folder, "reached")
	script := `#!/bin/sh
[ "$1" = app-server ] || exit 2
echo "$@" > ` + filepath.Join(folder, "args") + `
while read -r line; do
  echo "$line" >> ` + said + `
  id=$(printf '%s' "$line" | sed -n 's/^{"jsonrpc":"2.0","id":\([0-9]*\),.*/\1/p')
  [ -z "$id" ] && continue
  case "$line" in
    *'"method":"config/read"'*) printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$id" '` + config + `' ;;
    *'"method":"mcpServerStatus/list"'*|*'"method":"mcpServer/'*) touch ` + reached + `; printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
    *) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
  esac
done`
	program := filepath.Join(folder, "codex")
	if err := os.WriteFile(program, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return program, said, reached
}

func TestTheServersAndEnabledPluginsCodexsConfigurationNamesForAFolderAreReadThroughItsAppServerReachingNone(t *testing.T) {
	program, said, reached := anAppServerReadingConfig(t, `{"config":{"mcp_servers":{"dot.ted":{"url":"http://127.0.0.1:2/z","enabled":true},"projects_own":{"command":"echo","enabled":false}},"plugins":{"withmcp@probe-market":{"enabled":true},"old@probe-market":{"enabled":false}}},"origins":{}}`)

	configured, err := AppServer{Program: program, Version: "1.2.3"}.ConfiguredFor("/home/me/worktrees/scout", nil)

	slices.Sort(configured.McpServers)
	if err != nil || !slices.Equal(configured.McpServers, []string{"dot.ted", "projects_own"}) || !slices.Equal(configured.Plugins, []string{"withmcp@probe-market"}) {
		t.Fatalf("ConfiguredFor = %+v, %v, want dot.ted and projects_own, and withmcp@probe-market the one plugin enabled", configured, err)
	}
	lines := linesOf(said)
	if !slices.ContainsFunc(lines, func(line string) bool {
		return strings.Contains(line, `"method":"config/read"`) && strings.Contains(line, `"cwd":"/home/me/worktrees/scout"`)
	}) {
		t.Fatalf("the app server was sent %q, want config/read with the folder as its cwd, so the project's configuration applies", lines)
	}
	if _, err := os.Stat(reached); err == nil {
		t.Fatal("the listing asked for the servers' status, which starts and reaches each one")
	}
}

func TestAConfigurationNamingNoServerOrPluginListsNone(t *testing.T) {
	program, _, _ := anAppServerReadingConfig(t, `{"config":{"model":"gpt-5.6-terra"},"origins":{}}`)

	configured, err := AppServer{Program: program}.ConfiguredFor(t.TempDir(), nil)

	if err != nil || len(configured.McpServers) != 0 || len(configured.Plugins) != 0 {
		t.Fatalf("ConfiguredFor = %+v, %v, want none", configured, err)
	}
}

func TestAConfigReadWithoutAConfigurationIsAnError(t *testing.T) {
	program, _, _ := anAppServerReadingConfig(t, `{}`)

	if configured, err := (AppServer{Program: program}).ConfiguredFor(t.TempDir(), nil); err == nil {
		t.Fatalf("ConfiguredFor = %+v, want an error", configured)
	}
}

func TestTheConfigurationIsReadWithTheOverridesGivenAsTheAppServersOwn(t *testing.T) {
	program, said, _ := anAppServerReadingConfig(t, `{"config":{},"origins":{}}`)

	if _, err := (AppServer{Program: program}).ConfiguredFor(t.TempDir(), []string{"-c", "mcp_servers.from_flag={command=\"echo\"}", "--enable", "y"}); err != nil {
		t.Fatal(err)
	}

	if args, _ := os.ReadFile(filepath.Join(filepath.Dir(said), "args")); string(args) != "app-server -c mcp_servers.from_flag={command=\"echo\"} --enable y\n" {
		t.Fatalf("the app server ran as %q, want app-server with the overrides after it", args)
	}
}
