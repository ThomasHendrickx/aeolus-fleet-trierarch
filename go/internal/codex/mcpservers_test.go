package codex

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// aCodexListing is a stand-in for `codex mcp list --json`: it notes the folder it ran in and answers the listing given, exiting with the code given.
func aCodexListing(t *testing.T, listing string, code int) (string, string) {
	t.Helper()
	folder := t.TempDir()
	ranIn := filepath.Join(folder, "ran-in")
	script := `#!/bin/sh
[ "$*" = "mcp list --json" ] || exit 2
pwd > ` + ranIn + `
cat <<'LISTING'
` + listing + `
LISTING
exit ` + string(rune('0'+code)) + `
`
	program := filepath.Join(folder, "codex")
	if err := os.WriteFile(program, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return program, ranIn
}

func TestTheServersCodexListsInAFolderAreEachByItsName(t *testing.T) {
	program, ranIn := aCodexListing(t, `[{"name":"dot.ted","enabled":true,"transport":{"type":"streamable_http","url":"http://127.0.0.1:2/z"}},{"name":"usersown","enabled":false,"transport":{"type":"stdio","command":"echo"}}]`, 0)
	folder := t.TempDir()

	names, err := McpList{Program: program}.McpServersIn(folder)

	if err != nil || !slices.Equal(names, []string{"dot.ted", "usersown"}) {
		t.Fatalf("McpServersIn = %q, %v, want dot.ted and usersown", names, err)
	}
	if text, _ := os.ReadFile(ranIn); string(text) != folder+"\n" {
		t.Fatalf("listed in %q, want %q, where the project's own configuration applies", text, folder)
	}
}

func TestAListingCodexRefusesOrAnswersOtherThanJSONIsAnError(t *testing.T) {
	cases := map[string]struct {
		listing string
		code    int
	}{
		"codex exits 1":  {`[]`, 1},
		"not JSON":       {`Name  Command`, 0},
		"a nameless one": {`[{"enabled":true}]`, 0},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			program, _ := aCodexListing(t, test.listing, test.code)

			if names, err := (McpList{Program: program}).McpServersIn(t.TempDir()); err == nil {
				t.Fatalf("McpServersIn = %q, want an error", names)
			}
		})
	}
}
