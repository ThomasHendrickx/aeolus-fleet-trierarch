package copilot

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
)

// aCopilotListing is a stand-in for `copilot mcp list --json`: it notes the folder it ran in and the COPILOT_HOME it got, and answers the listing given, exiting with the code given.
func aCopilotListing(t *testing.T, listing string, code int) (string, string) {
	t.Helper()
	folder := t.TempDir()
	ran := filepath.Join(folder, "ran")
	script := `#!/bin/sh
[ "$*" = "mcp list --json" ] || exit 2
{ pwd; echo "$COPILOT_HOME"; } > ` + ran + `
cat <<'LISTING'
` + listing + `
LISTING
exit ` + strconv.Itoa(code) + `
`
	program := filepath.Join(folder, "copilot")
	if err := os.WriteFile(program, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return program, ran
}

func TestTheServersCopilotListsInAFolderAreEachByItsNameWithTheTrierarchsCopilotHome(t *testing.T) {
	program, ran := aCopilotListing(t, `{"mcpServers":{"usersown":{"type":"local","command":"echo","source":"user","enabled":true},"workspace_own":{"command":"echo","source":"workspace","enabled":false}}}`, 0)
	folder := t.TempDir()

	names, err := McpList{Program: program, CopilotHome: "/home/me/.copilot-work"}.McpServersIn(folder)

	slices.Sort(names)
	if err != nil || !slices.Equal(names, []string{"usersown", "workspace_own"}) {
		t.Fatalf("McpServersIn = %q, %v, want usersown and workspace_own", names, err)
	}
	if text, _ := os.ReadFile(ran); string(text) != folder+"\n/home/me/.copilot-work\n" {
		t.Fatalf("listed as %q, want in %s with COPILOT_HOME /home/me/.copilot-work, as its sessions run", text, folder)
	}
}

func TestAListingCopilotRefusesOrAnswersOtherThanJSONIsAnError(t *testing.T) {
	cases := map[string]struct {
		listing string
		code    int
	}{
		"copilot exits 1": {`{"mcpServers":{}}`, 1},
		"not JSON":        {`User servers:`, 0},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			program, _ := aCopilotListing(t, test.listing, test.code)

			if names, err := (McpList{Program: program}).McpServersIn(t.TempDir()); err == nil {
				t.Fatalf("McpServersIn = %q, want an error", names)
			}
		})
	}
}
