package copilot

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
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

	names, err := McpList{Program: program, CopilotHome: "/home/me/.copilot-work"}.McpServersIn(context.Background(), folder)

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

			if names, err := (McpList{Program: program}).McpServersIn(context.Background(), t.TempDir()); err == nil {
				t.Fatalf("McpServersIn = %q, want an error", names)
			}
		})
	}
}

func TestAListingCopilotDoesNotAnswerInTimeOrWhoseContextEndsIsAnErrorAtOnce(t *testing.T) {
	folder := t.TempDir()
	program := filepath.Join(folder, "copilot")
	// The sleep is a child of its own, holding the listing's output open after the shell is ended.
	if err := os.WriteFile(program, []byte("#!/bin/sh\nsleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	ended, cancel := context.WithCancel(context.Background())
	cancel()
	cases := map[string]struct {
		list    McpList
		context context.Context
	}{
		"past its time limit": {McpList{Program: program, Timeout: 200 * time.Millisecond}, context.Background()},
		"its context ended":   {McpList{Program: program}, ended},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			began := time.Now()

			names, err := test.list.McpServersIn(test.context, t.TempDir())

			if took := time.Since(began); err == nil || took > 5*time.Second {
				t.Fatalf("McpServersIn = %q, %v after %v, want an error within 5s, so a hung listing holds up no start", names, err, took)
			}
		})
	}
}

func TestAListingEndedForItsTimeEndsTheProcessesItStarted(t *testing.T) {
	folder := t.TempDir()
	program, child := filepath.Join(folder, "copilot"), filepath.Join(folder, "child")
	// As Copilot's npm launcher runs its native process, the listing runs one of its own.
	if err := os.WriteFile(program, []byte("#!/bin/sh\nsleep 30 &\necho $! > "+child+"\nwait\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := (McpList{Program: program, Timeout: 200 * time.Millisecond}).McpServersIn(context.Background(), t.TempDir()); err == nil {
		t.Fatal("McpServersIn = nil, want an error")
	}

	text, err := os.ReadFile(child)
	pid, _ := strconv.Atoi(strings.TrimSpace(string(text)))
	if err != nil || pid == 0 {
		t.Fatalf("the listing noted %q, %v, want its child's pid", text, err)
	}
	// An ended child is gone once whoever adopted it reaps it.
	for wait := time.Now().Add(2 * time.Second); syscall.Kill(pid, 0) == nil && time.Now().Before(wait); {
		time.Sleep(20 * time.Millisecond)
	}
	if syscall.Kill(pid, 0) == nil {
		_ = syscall.Kill(pid, syscall.SIGKILL)
		t.Fatalf("the listing's child %d still runs, want it ended with the listing", pid)
	}
}
