package claudecode

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/prompt"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/trash/trashtest"
)

const scout = "shp_01m6jyczpnpp5c0vxh54c966cy"

type aRuntime struct {
	started []sessions.Start
	sent    []string
}

func (r *aRuntime) Start(session sessions.Start) error {
	r.started = append(r.started, session)
	return nil
}

func (r *aRuntime) Send(shipID string, line string) error {
	r.sent = append(r.sent, line)
	return nil
}

type anOnboarding struct{ completed int }

func (o *anOnboarding) CompleteOnboarding() error {
	o.completed++
	return nil
}

func aHarness(t *testing.T) (Harness, *aRuntime, *anOnboarding) {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	running, onboarding := &aRuntime{}, &anOnboarding{}
	events := t.TempDir()
	return Harness{
		Plugin:     plugin.Plugin{Root: filepath.Join(filepath.Dir(file), "..", "..", "..", "plugins", "aeolus-fleet"), Data: t.TempDir(), Crews: t.TempDir()},
		Runtime:    running,
		Settings:   config.Harness{Flags: []string{"--model", "opus"}, Options: map[string]config.Option{}},
		Projects:   t.TempDir(),
		Onboarding: onboarding,
		Managed:    t.TempDir(),
		User:       filepath.Join(t.TempDir(), "settings.json"),
		Events:     func(shipID string) string { return filepath.Join(events, shipID+".jsonl") },
	}, running, onboarding
}

func anEntry(t *testing.T) reconciler.Entry {
	t.Helper()
	return reconciler.Entry{ShipID: scout, ShipName: "scout", Harness: "claude-code", Folder: t.TempDir(), Options: map[string]string{}, FirstPrompt: "Review PR 12"}
}

func TestAFirstStartRunsClaudeCodeInTheFolderWithItsLaunchIdAndItsFirstPrompt(t *testing.T) {
	harness, running, onboarding := aHarness(t)
	entry := anEntry(t)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if len(running.started) != 1 || running.started[0].Folder != entry.Folder || running.started[0].Harness != "claude-code" || running.started[0].Env["AEOLUS_LAUNCH"] != "launch-1" || slices.Contains(running.started[0].Command, "--continue") || !slices.Contains(running.started[0].Command, "opus") {
		t.Fatalf("started %+v", running.started)
	}
	if !slices.Equal(running.sent, []string{UserLine(prompt.First("Review PR 12"))}) || onboarding.completed != 1 {
		t.Fatalf("sent %q, onboarding %d", running.sent, onboarding.completed)
	}
}

func TestAStartAgainWakesTheSessionAndContinuesItsConversation(t *testing.T) {
	harness, running, _ := aHarness(t)
	entry := anEntry(t)
	kept := filepath.Join(harness.Projects, notLetterOrDigit.ReplaceAllString(entry.Folder, "-"))
	if err := os.MkdirAll(kept, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(kept, "a.jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := harness.Launch(entry, false, "launch-2"); err != nil {
		t.Fatal(err)
	}

	if !slices.Contains(running.started[0].Command, "--continue") || !slices.Equal(running.sent, []string{UserLine(WakePrompt())}) {
		t.Fatalf("started %+v, sent %q", running.started, running.sent)
	}
}

func TestAStartAgainWithNoConversationStartsFresh(t *testing.T) {
	harness, running, _ := aHarness(t)

	if err := harness.Launch(anEntry(t), false, "launch-2"); err != nil {
		t.Fatal(err)
	}

	if slices.Contains(running.started[0].Command, "--continue") {
		t.Fatalf("started %+v", running.started)
	}
}

func TestALaunchWithNoActivityNamesTheErrorClaudeCodeLastGave(t *testing.T) {
	harness, _, _ := aHarness(t)
	entry := anEntry(t)
	entry.LaunchID = "launch-1"
	events := `{"type":"system","subtype":"init"}` + "\n" + `{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}` + "\n"
	if err := os.WriteFile(harness.Events(scout), []byte(events), 0o600); err != nil {
		t.Fatal(err)
	}

	seen := harness.LaunchSeen(entry)

	if seen != (reconciler.LaunchSeen{Kind: reconciler.LaunchNone, Cause: "Not logged in · Please run /login"}) {
		t.Fatalf("seen %+v", seen)
	}
}

func TestAPluginWhoseScriptsAreGoneIsWhyNoSessionCanStart(t *testing.T) {
	harness, _, _ := aHarness(t)
	harness.Plugin.Root = t.TempDir()

	if harness.Problem() == nil {
		t.Fatalf("no problem with a plugin with no scripts")
	}
}

func (r *aRuntime) Interrupt(shipID string) error {
	r.sent = append(r.sent, "interrupt")
	return nil
}

// withPushAnswering makes the harness's plugin a stand-in whose aeolus-push.sh prints the line and exits with the code given.
func withPushAnswering(t *testing.T, harness Harness, line string, code int) Harness {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "scripts"), 0o755); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\necho '" + line + "'\nexit " + strconv.Itoa(code) + "\n"
	if err := os.WriteFile(filepath.Join(root, "scripts", "aeolus-push.sh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	harness.Plugin.Root = root
	return harness
}

func TestAHandOverTypesThePluginsLineIntoTheSessionAsAWake(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness = withPushAnswering(t, harness, "Aeolus handed a message", 0)

	isHanded, err := harness.HandOver(anEntry(t))

	if err != nil || !isHanded {
		t.Fatalf("HandOver = %v %v, want handed", isHanded, err)
	}
	want := UserLine("Aeolus handed a message " + prompt.NoTerminalQuestions)
	if !slices.Equal(running.sent, []string{want}) {
		t.Fatalf("sent %q, want %q", running.sent, want)
	}
}

func TestNothingHandedOverTypesNothing(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness = withPushAnswering(t, harness, "", 1)

	isHanded, err := harness.HandOver(anEntry(t))

	if err != nil || isHanded || len(running.sent) != 0 {
		t.Fatalf("HandOver = %v %v, sent %q, want nothing", isHanded, err, running.sent)
	}
}

func TestAForcedMessageStopsABusyTurnBeforeItsLineGoesIn(t *testing.T) {
	cases := []struct {
		isTurnBusy bool
		want       []string
	}{
		{true, []string{"interrupt", UserLine("Aeolus forced " + prompt.NoTerminalQuestions)}},
		{false, []string{UserLine("Aeolus forced " + prompt.NoTerminalQuestions)}},
	}
	for _, c := range cases {
		harness, running, _ := aHarness(t)
		harness = withPushAnswering(t, harness, "Aeolus forced", 0)

		isHanded, err := harness.ForceOver(anEntry(t), c.isTurnBusy)

		if err != nil || !isHanded || !slices.Equal(running.sent, c.want) {
			t.Fatalf("ForceOver(busy %v) = %v %v, sent %q, want %q", c.isTurnBusy, isHanded, err, running.sent, c.want)
		}
	}
}

func TestASessionOnAnAPIKeyStartsWithTheProxyAsItsBaseURLAndAFreshTokenOfItsOwn(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.ProxyURL = func() (string, bool) { return "http://127.0.0.1:41000", true }
	entry := anEntry(t)
	entry.Login = "apiKey"

	for range 2 {
		if err := harness.Launch(entry, false, "launch-1"); err != nil {
			t.Fatal(err)
		}
	}

	first, second := running.started[0], running.started[1]
	if first.Env["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:41000/anthropic" || first.ProxyToken == nil || first.ProxyToken.Variable != "ANTHROPIC_AUTH_TOKEN" || first.ProxyToken.Harness != "claude-code" || first.ProxyToken.Token == "" {
		t.Fatalf("started %+v with token %+v, want the proxy's address and a token in ANTHROPIC_AUTH_TOKEN", first, first.ProxyToken)
	}
	if second.ProxyToken == nil || second.ProxyToken.Token == first.ProxyToken.Token {
		t.Fatal("the second start has the first one's token, want a fresh one")
	}
	if _, ok := first.Env["ANTHROPIC_AUTH_TOKEN"]; ok {
		t.Fatal("the token is among the variables given on the hold's command line")
	}
}

func TestASessionOnItsSubscriptionGetsNoRouteToTheProxyAndNoToken(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.ProxyURL = func() (string, bool) { return "http://127.0.0.1:41000", true }
	entry := anEntry(t)
	entry.Login = "subscription"

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if _, ok := running.started[0].Env["ANTHROPIC_BASE_URL"]; ok || running.started[0].ProxyToken != nil {
		t.Fatalf("started %+v, want no proxy and no token", running.started[0])
	}
}

func TestASessionOnAnAPIKeyDoesNotStartBeforeTheProxyListens(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.ProxyURL = func() (string, bool) { return "", false }
	entry := anEntry(t)
	entry.Login = "apiKey"

	err := harness.Launch(entry, true, "launch-1")

	if err == nil || len(running.started) != 0 {
		t.Fatalf("Launch = %v, started %d, want an error and nothing started", err, len(running.started))
	}
}

// mcpConfig is a session's MCP configuration as Claude Code reads it.
type mcpConfig struct {
	McpServers map[string]struct {
		Type    string            `json:"type"`
		URL     string            `json:"url"`
		Headers map[string]string `json:"headers"`
	} `json:"mcpServers"`
}

func TestASessionNamingMCPServersStartsWithEachAtTheMCPProxyWithAFreshTokenOfItsOwn(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.ProxyURL = func() (string, bool) { return "http://127.0.0.1:41000", true }
	harness.Sessions = t.TempDir()
	entry := anEntry(t)
	entry.McpServers = []string{"company-graph", "notes"}

	for range 2 {
		if err := harness.Launch(entry, false, "launch-1"); err != nil {
			t.Fatal(err)
		}
	}

	first, second := running.started[0], running.started[1]
	path := filepath.Join(harness.Sessions, scout, "mcp-config.json")
	if at := slices.Index(first.Command, "--mcp-config"); at < 0 || at+1 >= len(first.Command) || first.Command[at+1] != path {
		t.Fatalf("command %q, want --mcp-config %s", first.Command, path)
	}
	if first.Mcp == nil || first.Mcp.Access.Token == "" || !slices.Equal(first.Mcp.Access.Servers, []string{"company-graph", "notes"}) {
		t.Fatalf("started with MCP %+v, want a token for company-graph and notes", first.Mcp)
	}
	if second.Mcp == nil || second.Mcp.Access.Token == first.Mcp.Access.Token {
		t.Fatal("the second start has the first one's MCP token, want a fresh one")
	}
	var config mcpConfig
	if err := json.Unmarshal(first.Mcp.Config, &config); err != nil {
		t.Fatalf("the MCP configuration %s: %v", first.Mcp.Config, err)
	}
	if len(config.McpServers) != 2 {
		t.Fatalf("the MCP configuration names %v, want company-graph and notes", config.McpServers)
	}
	for _, name := range []string{"company-graph", "notes"} {
		server := config.McpServers[name]
		if want := "http://127.0.0.1:41000/mcp/" + scout + "/" + name; server.Type != "http" || server.URL != want || server.Headers["Authorization"] != "Bearer "+first.Mcp.Access.Token {
			t.Errorf("the MCP configuration's %s = %+v, want http at %s with the session's token", name, server, want)
		}
	}
	if line := strings.Join(first.Command, " "); strings.Contains(line, first.Mcp.Access.Token) || strings.Contains(line, "/mcp/") {
		t.Fatalf("the command line %q holds the token or a server's URL", line)
	}
}

func TestASessionNamingNoMCPServerStartsWithoutAnMCPConfiguration(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.ProxyURL = func() (string, bool) { return "http://127.0.0.1:41000", true }
	harness.Sessions = t.TempDir()

	if err := harness.Launch(anEntry(t), true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if slices.Contains(running.started[0].Command, "--mcp-config") || running.started[0].Mcp != nil {
		t.Fatalf("started %+v, want no MCP configuration", running.started[0])
	}
}

func TestASessionNamingMCPServersDoesNotStartBeforeTheProxyListens(t *testing.T) {
	cases := map[string]func(harness *Harness){
		"before the proxy listens": func(harness *Harness) { harness.ProxyURL = func() (string, bool) { return "", false } },
	}
	for name, setUp := range cases {
		t.Run(name, func(t *testing.T) {
			harness, running, _ := aHarness(t)
			harness.Sessions = t.TempDir()
			setUp(&harness)
			entry := anEntry(t)
			entry.McpServers = []string{"company-graph"}

			err := harness.Launch(entry, true, "launch-1")

			if err == nil || len(running.started) != 0 {
				t.Fatalf("Launch = %v, started %d, want an error and nothing started", err, len(running.started))
			}
		})
	}
}

func TestASessionGetsOnlyTheMCPServersItsEntryNamesNoneOfTheUsersOrClaudeAisConnectors(t *testing.T) {
	cases := map[string][]string{"naming company-graph": {"company-graph"}, "naming none": nil}
	for name, servers := range cases {
		t.Run(name, func(t *testing.T) {
			harness, running, _ := aHarness(t)
			harness.ProxyURL = func() (string, bool) { return "http://127.0.0.1:41000", true }
			harness.Sessions = t.TempDir()
			entry := anEntry(t)
			entry.McpServers = servers

			if err := harness.Launch(entry, true, "launch-1"); err != nil {
				t.Fatal(err)
			}

			started := running.started[0]
			if !slices.Contains(started.Command, "--strict-mcp-config") {
				t.Errorf("command %q, want --strict-mcp-config, so no server of the user's or the folder's configuration loads", started.Command)
			}
			if got := started.Env["ENABLE_CLAUDEAI_MCP_SERVERS"]; got != "false" {
				t.Errorf("ENABLE_CLAUDEAI_MCP_SERVERS = %q, want false, so no claude.ai connector loads", got)
			}
		})
	}
}

func TestASessionWhoseFoldersSettingsMakePlanTheDefaultModeStartsInManualMode(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.PermissionModes = func() []string { return []string{"default", "manual"} }
	entry := anEntry(t)
	write(t, filepath.Join(entry.Folder, ".claude", "settings.json"), planSettings)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if command := running.started[0].Command; !slices.Contains(command, "--permission-mode") || command[slices.Index(command, "--permission-mode")+1] != "manual" {
		t.Fatalf("started %q", command)
	}
}

func TestASessionStartsInDefaultModeWhereTheInstalledClaudeCodeListsNoManual(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.PermissionModes = func() []string { return []string{"default"} }
	entry := anEntry(t)
	write(t, harness.User, planSettings)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if command := running.started[0].Command; command[slices.Index(command, "--permission-mode")+1] != "default" {
		t.Fatalf("started %q", command)
	}
}

func TestASessionWhoseFlagsNameAModeOrWhoseSettingsMakeNoPlanDefaultGetsNoOverride(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.PermissionModes = func() []string { return []string{"manual"} }
	entry := anEntry(t)
	write(t, harness.User, `{"permissions":{"defaultMode":"acceptEdits"}}`)
	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}
	harness.Settings.Flags = []string{"--permission-mode", "acceptEdits"}
	write(t, harness.User, planSettings)
	if err := harness.Launch(entry, true, "launch-2"); err != nil {
		t.Fatal(err)
	}

	first, second := running.started[0].Command, running.started[1].Command
	if slices.Contains(first, "manual") || slices.Contains(second, "manual") || !slices.Contains(second, "acceptEdits") {
		t.Fatalf("started %q and %q", first, second)
	}
}

func TestASessionLaunchedBeforeDetectionFoundPermissionModesStartsInDefaultMode(t *testing.T) {
	harness, running, _ := aHarness(t)
	entry := anEntry(t)
	write(t, harness.User, planSettings)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if command := running.started[0].Command; command[slices.Index(command, "--permission-mode")+1] != "default" {
		t.Fatalf("started %q", command)
	}
}

func TestASessionIsStartedReadingItsReadOnlyCheckouts(t *testing.T) {
	harness, running, _ := aHarness(t)
	entry := anEntry(t)
	entry.ReadOnly = []string{"/checkouts/shp_scout/governance"}

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	command := running.started[0].Command
	if !slices.Equal(command[len(command)-2:], []string{"--add-dir", "/checkouts/shp_scout/governance"}) {
		t.Fatalf("command %q", command)
	}
}

func TestASessionsReadOnlyCheckoutsAreNamedToItsRuntime(t *testing.T) {
	harness, running, _ := aHarness(t)
	entry := anEntry(t)
	entry.ReadOnly = []string{"/checkouts/shp_scout/governance"}

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if got := running.started[0].ReadOnly; !slices.Equal(got, []string{"/checkouts/shp_scout/governance"}) {
		t.Fatalf("read-only %q", got)
	}
}

// inContainers is the harness with a home of each ship's own under homes, as sessions in containers have them, the host's user settings in hostSettings.
func inContainers(t *testing.T) (Harness, *aRuntime, *anOnboarding, string) {
	t.Helper()
	harness, running, onboarding := aHarness(t)
	homes := t.TempDir()
	harness.Homes = homes
	return harness, running, onboarding, filepath.Join(homes, scout)
}

func anIdentity() plugin.Identity {
	return plugin.Identity{FleetURL: "https://fleet.example", ShipID: scout, ShipName: "scout", Socket: "/sockets/" + scout + "/fleet.sock"}
}

func filesUnder(t *testing.T, folder string) []string {
	t.Helper()
	var files []string
	_ = filepath.WalkDir(folder, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			files = append(files, path)
		}
		return nil
	})
	return files
}

func TestInContainersAShipsIdentityIsKeptInItsOwnHomeNeverTheUsers(t *testing.T) {
	harness, _, _, home := inContainers(t)
	entry := anEntry(t)

	if err := harness.WriteIdentity(entry, anIdentity(), "crew-token"); err != nil {
		t.Fatal(err)
	}

	if len(filesUnder(t, filepath.Join(home, ".aeolus", "crews", "claude-code"))) == 0 || len(filesUnder(t, harness.Plugin.Crews)) != 0 {
		t.Fatalf("the ship's home holds %q, the user's %q", filesUnder(t, home), filesUnder(t, harness.Plugin.Crews))
	}
	if !harness.HasIdentity(entry) {
		t.Fatal("the identity in the ship's home is not found")
	}
}

func TestInContainersAShipsHomeGoesWithItsIdentity(t *testing.T) {
	harness, _, _, home := inContainers(t)
	entry := anEntry(t)
	if err := harness.WriteIdentity(entry, anIdentity(), "crew-token"); err != nil {
		t.Fatal(err)
	}

	if err := harness.DeleteIdentity(entry); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(home); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the ship's home is still there: %v", err)
	}
}

func TestInContainersAShipsHomeHoldingWhatTheHostCannotRemoveGoesWithItsIdentityToTheTrashBesideIt(t *testing.T) {
	// So the test's own folders can go whatever the outcome.
	writable := func(t *testing.T, homes string) {
		t.Cleanup(func() {
			_ = filepath.WalkDir(homes, func(path string, entry os.DirEntry, err error) error {
				if err == nil && entry.IsDir() {
					_ = os.Chmod(path, 0o755)
				}
				return nil
			})
		})
	}
	cases := map[string]func(t *testing.T, harness *Harness, home string){
		"its own top folder its session made read-only": func(t *testing.T, harness *Harness, home string) {
			writable(t, harness.Homes)
			if err := os.Chmod(home, 0o555); err != nil {
				t.Fatal(err)
			}
		},
		"its own top folder the host cannot move": func(t *testing.T, harness *Harness, home string) {
			harness.MoveWithinUserNamespace = trashtest.MoveAsRuntime
			trashtest.Unmovable(t, harness.Homes, home)
		},
		"a folder its session made read-only": func(t *testing.T, harness *Harness, home string) {
			homes := harness.Homes
			readOnly := filepath.Join(home, ".local", "share", "containers")
			if err := os.MkdirAll(readOnly, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(readOnly, "layer"), []byte("layer\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(readOnly, 0o500); err != nil {
				t.Fatal(err)
			}
			writable(t, homes)
		},
		"a folder it cannot remove": func(t *testing.T, harness *Harness, home string) {
			trashtest.Unremovable(t, harness.Homes, home)
		},
	}
	for name, holding := range cases {
		t.Run(name, func(t *testing.T) {
			harness, _, _, home := inContainers(t)
			entry := anEntry(t)
			if err := harness.WriteIdentity(entry, anIdentity(), "crew-token"); err != nil {
				t.Fatal(err)
			}
			holding(t, &harness, home)

			if err := harness.DeleteIdentity(entry); err != nil {
				t.Fatalf("DeleteIdentity() with %s in the ship's home = %v, want it gone", name, err)
			}

			if _, err := os.Lstat(home); !errors.Is(err, os.ErrNotExist) {
				t.Errorf("the ship's home is still there: %v", err)
			}
			if entries, err := os.ReadDir(filepath.Join(harness.Homes, ".trash")); err != nil || len(entries) != 1 {
				t.Errorf("the trash beside it holds %v (%v), want the home", entries, err)
			}
		})
	}
}

func TestInContainersClaudeCodesQuestionsAreAnsweredInTheShipsOwnHomeBeforeEachLaunch(t *testing.T) {
	harness, _, onboarding, home := inContainers(t)
	entry := anEntry(t)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	claude := Of(home, "")
	if trusted := claude.TrustedFolders(); !trusted[entry.Folder] || onboarding.completed != 0 {
		t.Fatalf("trusted %v in the ship's home, the user's onboarding completed %d times", trusted, onboarding.completed)
	}
	if text, _ := os.ReadFile(claude.ClaudeJSON); !strings.Contains(string(text), `"hasCompletedOnboarding": true`) {
		t.Fatalf(".claude.json:\n%s", text)
	}
	if info, err := os.Stat(home); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("the ship's home: %v, %v", info, err)
	}
}

func TestInContainersBypassPermissionsIsAcceptedInTheShipsHomeOnlyWhereTheOperatorAcceptedItOnTheHost(t *testing.T) {
	for _, isAccepted := range []bool{false, true} {
		harness, _, _, home := inContainers(t)
		if isAccepted {
			write(t, harness.User, `{"skipDangerousModePermissionPrompt":true}`)
		}

		if err := harness.Launch(anEntry(t), true, "launch-1"); err != nil {
			t.Fatal(err)
		}

		if got := IsSkipPermissionsAccepted(filepath.Join(home, ".claude", "settings.json")); got != isAccepted {
			t.Errorf("accepted on the host %v: accepted in the ship's home %v", isAccepted, got)
		}
	}
}

func TestInContainersAStartAgainContinuesTheConversationKeptInTheShipsHome(t *testing.T) {
	harness, running, _, home := inContainers(t)
	entry := anEntry(t)
	kept := filepath.Join(home, ".claude", "projects", notLetterOrDigit.ReplaceAllString(entry.Folder, "-"))
	if err := os.MkdirAll(kept, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(kept, "a.jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := harness.Launch(entry, false, "launch-2"); err != nil {
		t.Fatal(err)
	}

	if !slices.Contains(running.started[0].Command, "--continue") {
		t.Fatalf("started %q", running.started[0].Command)
	}
}

func TestInContainersThePlanDefaultModeIsReadFromTheShipsHome(t *testing.T) {
	harness, running, _, home := inContainers(t)
	harness.PermissionModes = func() []string { return []string{"default", "plan"} }
	write(t, filepath.Join(home, ".claude", "settings.json"), planSettings)

	if err := harness.Launch(anEntry(t), true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if command := running.started[0].Command; !slices.Contains(command, "--permission-mode") {
		t.Fatalf("started %q", command)
	}
}

func TestInContainersASessionNamingMCPServersReachesThemAtTheProxyWithItsConfigurationInItsSessionsFolder(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.ProxyURL = func() (string, bool) { return "http://127.0.0.1:41000", true }
	harness.Sessions = t.TempDir()
	harness.Homes = t.TempDir()
	entry := anEntry(t)
	entry.McpServers = []string{"company-graph"}

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	started := running.started[0]
	want := filepath.Join(harness.Sessions, scout, "mcp-config.json")
	if at := slices.Index(started.Command, "--mcp-config"); at < 0 || at+1 >= len(started.Command) || started.Command[at+1] != want {
		t.Fatalf("command %q, want --mcp-config %s, in the session's folder, which the container cannot write", started.Command, want)
	}
	var config mcpConfig
	if err := json.Unmarshal(started.Mcp.Config, &config); err != nil {
		t.Fatal(err)
	}
	if got, want := config.McpServers["company-graph"].URL, "http://127.0.0.1:41000/mcp/"+scout+"/company-graph"; got != want {
		t.Fatalf("the configuration's URL = %q, want %q, the proxy at the address the container reaches it", got, want)
	}
	if line := strings.Join(started.Command, " "); strings.Contains(line, started.Mcp.Access.Token) {
		t.Fatalf("the command line %q holds the token", line)
	}
}

func TestInContainersALinkASessionPlantedInItsShipsHomeIsNeverWrittenThroughAcrossARestart(t *testing.T) {
	harness, _, _ := aHarness(t)
	harness.ProxyURL = func() (string, bool) { return "http://127.0.0.1:41000", true }
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// A short folder: a hold's socket path has a limit t.TempDir's names exceed.
	folder, err := os.MkdirTemp("", "sessions")
	if err != nil {
		t.Fatal(err)
	}
	held := sessions.Runtime{Sessions: folder, Program: []string{program}, Version: "1.2.3", BootedAt: func() time.Time { return time.Now().Add(-time.Hour) }}
	// The container's run, which these tests do not start: a session that takes its lines.
	held.HeldAs = func(session sessions.Start, _ hold.Files) (sessions.Start, error) {
		session.Command = []string{"sh", "-c", "while read -r line; do :; done"}
		return session, nil
	}
	t.Cleanup(func() {
		_ = held.Stop(scout)
		_ = os.RemoveAll(folder)
	})
	harness.Runtime, harness.Sessions, harness.Homes = held, held.Sessions, t.TempDir()
	entry := anEntry(t)
	entry.McpServers = []string{"company-graph"}
	outside := filepath.Join(t.TempDir(), "the-hosts-own-file")
	if err := os.WriteFile(outside, []byte("the host's own file"), 0o644); err != nil {
		t.Fatal(err)
	}
	planted := filepath.Join(harness.Homes, scout, ".aeolus", "mcp-config.json")
	if err := os.MkdirAll(filepath.Dir(planted), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, planted); err != nil {
		t.Fatal(err)
	}

	for _, isFirstStart := range []bool{true, false} {
		if err := harness.Launch(entry, isFirstStart, "launch-1"); err != nil {
			t.Fatal(err)
		}
	}

	if got := readText(t, outside); got != "the host's own file" {
		t.Fatalf("%s holds %q, want the host's own file untouched", outside, got)
	}
}

func readText(t *testing.T, path string) string {
	t.Helper()
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}
