package codex

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// anAppServer is a stand-in for `codex app-server`: it notes each line it is sent and answers each request by its id, hooks/list with the hooks given.
func anAppServer(t *testing.T, hooks string) (string, string) {
	t.Helper()
	folder := t.TempDir()
	said := filepath.Join(folder, "said.jsonl")
	script := `#!/bin/sh
[ "$1" = app-server ] || exit 2
while read -r line; do
  echo "$line" >> ` + said + `
  id=$(printf '%s' "$line" | sed -n 's/^{"jsonrpc":"2.0","id":\([0-9]*\),.*/\1/p')
  [ -z "$id" ] && continue
  case "$line" in
    *'"method":"hooks/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"data":[{"hooks":%s}]}}\n' "$id" '` + hooks + `' ;;
    *) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
  esac
done`
	program := filepath.Join(folder, "codex")
	if err := os.WriteFile(program, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return program, said
}

func linesOf(path string) []string {
	text, _ := os.ReadFile(path)
	return strings.Split(strings.TrimSpace(string(text)), "\n")
}

func TestTrustingFoldersWritesEachTrustedThroughCodexsAppServerAfterItIntroducesItself(t *testing.T) {
	program, said := anAppServer(t, `[]`)

	if err := (AppServer{Program: program, Version: "1.2.3"}).Trust([]string{"/home/me/aeolus-fleet", "/home/me/notes"}); err != nil {
		t.Fatal(err)
	}

	want := []string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"aeolus-trierarch","version":"1.2.3"}}}`,
		`{"jsonrpc":"2.0","method":"initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"config/batchWrite","params":{"edits":[{"keyPath":"projects","value":{"/home/me/aeolus-fleet":{"trust_level":"trusted"},"/home/me/notes":{"trust_level":"trusted"}},"mergeStrategy":"upsert"}],"reloadUserConfig":true}}`,
	}
	if got := linesOf(said); !slices.Equal(got, want) {
		t.Fatalf("the app server was sent\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestTheAeolusPluginsNewOrChangedHooksAreTrustedByTheirCurrentHashAndNoOthers(t *testing.T) {
	hooks := `[{"key":"a","pluginId":"aeolus-fleet@aeolus-fleet","currentHash":"h-a","trustStatus":"untrusted"},{"key":"b","pluginId":"aeolus-fleet@aeolus-fleet","currentHash":"h-b","trustStatus":"modified"},{"key":"c","pluginId":"aeolus-fleet@aeolus-fleet","currentHash":"h-c","trustStatus":"trusted"},{"key":"d","pluginId":"other@market","currentHash":"h-d","trustStatus":"untrusted"}]`
	program, said := anAppServer(t, hooks)

	trusted, err := (AppServer{Program: program, Version: "1.2.3"}).TrustAeolusHooks("/home/me/worktrees/scout")

	if err != nil || !slices.Equal(trusted, []string{"a", "b"}) {
		t.Fatalf("TrustAeolusHooks = %q %v, want a and b", trusted, err)
	}
	got := linesOf(said)
	if want := `{"jsonrpc":"2.0","id":2,"method":"hooks/list","params":{"cwds":["/home/me/worktrees/scout"]}}`; len(got) < 3 || got[2] != want {
		t.Fatalf("the app server was sent %q, want the hooks listed from the folder: %s", got, want)
	}
	if want := `{"jsonrpc":"2.0","id":3,"method":"config/batchWrite","params":{"edits":[{"keyPath":"hooks.state","value":{"a":{"trusted_hash":"h-a"},"b":{"trusted_hash":"h-b"}},"mergeStrategy":"upsert"}],"reloadUserConfig":true}}`; len(got) != 4 || got[3] != want {
		t.Fatalf("the app server was sent %q, want the two hooks trusted: %s", got, want)
	}
}

func TestHooksTrustedAlreadyWriteNothing(t *testing.T) {
	program, said := anAppServer(t, `[{"key":"c","pluginId":"aeolus-fleet@aeolus-fleet","currentHash":"h-c","trustStatus":"trusted"}]`)

	trusted, err := (AppServer{Program: program, Version: "1.2.3"}).TrustAeolusHooks("/home/me/worktrees/scout")

	if err != nil || len(trusted) != 0 || len(linesOf(said)) != 3 {
		t.Fatalf("TrustAeolusHooks = %q %v, sent %q, want nothing written", trusted, err, linesOf(said))
	}
}

func TestAnAppServerThatEndsBeforeItAnswersIsAnError(t *testing.T) {
	program := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(program, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := (AppServer{Program: program, Version: "1.2.3"}).Trust([]string{"/home/me/notes"}); err == nil {
		t.Fatal("Trust = nil, want the app server's end said")
	}
}

func TestAnAppServerThatRefusesARequestIsAnErrorNamingIt(t *testing.T) {
	program := filepath.Join(t.TempDir(), "codex")
	script := `#!/bin/sh
while read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/^{"jsonrpc":"2.0","id":\([0-9]*\),.*/\1/p')
  [ -z "$id" ] && continue
  case "$line" in
    *initialize*) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
    *) printf '{"jsonrpc":"2.0","id":%s,"error":{"message":"no such key"}}\n' "$id" ;;
  esac
done`
	if err := os.WriteFile(program, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := (AppServer{Program: program, Version: "1.2.3"}).Trust([]string{"/home/me/notes"}); err == nil || !strings.Contains(err.Error(), "config/batchWrite: no such key") {
		t.Fatalf("Trust = %v, want the refusal named", err)
	}
}
