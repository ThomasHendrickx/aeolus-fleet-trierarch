package codex

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/prompt"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
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

func (r *aRuntime) Interrupt(shipID string) error {
	r.sent = append(r.sent, "interrupt")
	return nil
}

// someHooks trusts the aeolus-fleet plugin's hooks as Codex's app server would, noting each folder, or fails with the error given.
type someHooks struct {
	trustedFrom []string
	err         error
}

func (h *someHooks) TrustAeolusHooks(folder string) ([]string, error) {
	h.trustedFrom = append(h.trustedFrom, folder)
	return nil, h.err
}

// someServers are the MCP servers and enabled plugins Codex's configuration names for a folder, the user's own, noting each folder it is asked about and the configuration flags it is read with, or fails with the error given.
type someServers struct {
	names     []string
	plugins   []string
	askedFrom []string
	askedWith [][]string
	err       error
}

func (s *someServers) ConfiguredFor(folder string, overrides []string) (Configured, error) {
	s.askedFrom = append(s.askedFrom, folder)
	s.askedWith = append(s.askedWith, overrides)
	return Configured{McpServers: s.names, Plugins: s.plugins}, s.err
}

func aHarness(t *testing.T) (Harness, *aRuntime, *someHooks) {
	t.Helper()
	harness, running, hooks, _ := aHarnessListing(t)
	return harness, running, hooks
}

// aHarnessListing is aHarness with the MCP servers Codex lists in a folder, none until a test names some.
func aHarnessListing(t *testing.T) (Harness, *aRuntime, *someHooks, *someServers) {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	running, hooks, servers := &aRuntime{}, &someHooks{}, &someServers{}
	events := t.TempDir()
	return Harness{
		Plugin:        plugin.Plugin{Root: filepath.Join(filepath.Dir(file), "..", "..", "..", "plugins", "aeolus-fleet"), Data: t.TempDir(), Crews: t.TempDir()},
		Runtime:       running,
		Settings:      func() config.Harness { return config.Harness{Flags: []string{"-m", "gpt-5.6-terra"}, Options: map[string]config.Option{}} },
		Hooks:         hooks,
		Configuration: servers,
		Events:        func(shipID string) string { return filepath.Join(events, shipID+".jsonl") },
	}, running, hooks, servers
}

func anEntry(t *testing.T) reconciler.Entry {
	t.Helper()
	return reconciler.Entry{ShipID: scout, ShipName: "scout", Harness: "codex", Folder: t.TempDir(), Options: map[string]string{}, FirstPrompt: "Review PR 12"}
}

func TestAFirstStartRunsCodexExecInTheFolderWithItsFirstPromptAndItsLaunchIdTheHooksTrustedFirst(t *testing.T) {
	harness, running, hooks := aHarness(t)
	entry := anEntry(t)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	want := CommandLine([]string{"-m", "gpt-5.6-terra"}, prompt.First("Review PR 12"), true)
	if len(running.started) != 1 || !slices.Equal(running.started[0].Command, want) || running.started[0].Folder != entry.Folder || running.started[0].Harness != "codex" || running.started[0].Env["AEOLUS_LAUNCH"] != "launch-1" {
		t.Fatalf("started %+v, want %q in the folder as codex with its launch id", running.started, want)
	}
	if !slices.Equal(hooks.trustedFrom, []string{entry.Folder}) || len(running.sent) != 0 {
		t.Fatalf("hooks trusted from %q, sent %q, want the folder's hooks trusted and nothing sent", hooks.trustedFrom, running.sent)
	}
}

func TestALaunchTakesItsModelsFlagAsCodexIsOfferedAtTheLaunchNotAsItWasAtStart(t *testing.T) {
	harness, running, _ := aHarness(t)
	offered := config.Harness{Flags: []string{}, Options: map[string]config.Option{}}
	harness.Settings = func() config.Harness { return offered }
	// Codex's models are confirmed again after the trierarch started, and list the model the request picks (#335).
	offered = config.Harness{Flags: []string{}, Options: map[string]config.Option{"model": {Values: map[string][]string{"gpt-6.1-terra": {"-m", "gpt-6.1-terra"}}}}}
	entry := anEntry(t)
	entry.Options = map[string]string{"model": "gpt-6.1-terra"}

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if want := CommandLine([]string{"-m", "gpt-6.1-terra"}, prompt.First("Review PR 12"), true); len(running.started) != 1 || !slices.Equal(running.started[0].Command, want) {
		t.Fatalf("started %+v, want %q", running.started, want)
	}
}

func TestAStartAgainWakesTheFoldersLastConversation(t *testing.T) {
	harness, running, _ := aHarness(t)

	if err := harness.Launch(anEntry(t), false, "launch-2"); err != nil {
		t.Fatal(err)
	}

	if want := CommandLine([]string{"-m", "gpt-5.6-terra"}, "$aeolus-fleet-wake "+prompt.NoTerminalQuestions, false); !slices.Equal(running.started[0].Command, want) {
		t.Fatalf("started %q, want %q", running.started[0].Command, want)
	}
}

func TestALaunchWhoseHooksCannotBeTrustedStartsNothing(t *testing.T) {
	harness, running, hooks := aHarness(t)
	hooks.err = errors.New("codex app-server did not answer hooks/list")

	if err := harness.Launch(anEntry(t), true, "launch-1"); err == nil || len(running.started) != 0 {
		t.Fatalf("Launch = %v, started %d, want an error and nothing started", err, len(running.started))
	}
}

func TestASessionOnAnAPIKeyHasTheProxyAsItsModelProviderAndAFreshTokenOfItsOwn(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.ProxyURL = func() (string, bool) { return "http://127.0.0.1:41000", true }
	entry := anEntry(t)
	entry.Login = "apiKey"

	for range 2 {
		if err := harness.Launch(entry, true, "launch-1"); err != nil {
			t.Fatal(err)
		}
	}

	first, second := running.started[0], running.started[1]
	provider := []string{
		"-c", `model_providers.aeolus.name="Aeolus model proxy"`,
		"-c", `model_providers.aeolus.base_url="http://127.0.0.1:41000/openai/v1"`,
		"-c", `model_providers.aeolus.env_key="AEOLUS_MODEL_TOKEN"`,
		"-c", `model_providers.aeolus.wire_api="responses"`,
		"-c", `model_provider="aeolus"`,
	}
	if want := CommandLine(append([]string{"-m", "gpt-5.6-terra"}, provider...), prompt.First("Review PR 12"), true); !slices.Equal(first.Command, want) {
		t.Fatalf("started %q, want %q", first.Command, want)
	}
	if first.ProxyToken == nil || first.ProxyToken.Harness != "codex" || first.ProxyToken.Variable != "AEOLUS_MODEL_TOKEN" || first.ProxyToken.Token == "" {
		t.Fatalf("proxy token %+v, want a token of codex's in AEOLUS_MODEL_TOKEN", first.ProxyToken)
	}
	if second.ProxyToken == nil || second.ProxyToken.Token == first.ProxyToken.Token {
		t.Fatal("the second start has the first one's token, want a fresh one")
	}
}

func TestASessionOnItsSubscriptionGetsNoModelProviderAndNoToken(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.ProxyURL = func() (string, bool) { return "http://127.0.0.1:41000", true }
	entry := anEntry(t)
	entry.Login = "subscription"

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if slices.ContainsFunc(running.started[0].Command, func(word string) bool { return strings.Contains(word, "model_provider") }) || running.started[0].ProxyToken != nil {
		t.Fatalf("started %+v, want no model provider and no token", running.started[0])
	}
}

func TestASessionOnAnAPIKeyDoesNotStartBeforeTheProxyListens(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.ProxyURL = func() (string, bool) { return "", false }
	entry := anEntry(t)
	entry.Login = "apiKey"

	if err := harness.Launch(entry, true, "launch-1"); err == nil || len(running.started) != 0 {
		t.Fatalf("Launch = %v, started %d, want an error and nothing started", err, len(running.started))
	}
}

func TestALaunchWithNoActivityNamesTheErrorCodexLastGave(t *testing.T) {
	harness, _, _ := aHarness(t)
	entry := anEntry(t)
	entry.LaunchID = "launch-1"
	if err := os.WriteFile(harness.Events(scout), []byte(`{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if seen, want := harness.LaunchSeen(entry), (reconciler.LaunchSeen{Kind: reconciler.LaunchNone, Cause: "unexpected status 401 Unauthorized"}); seen != want {
		t.Fatalf("LaunchSeen = %+v, want %+v", seen, want)
	}
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

func TestAHandOverIsATurnOfThePluginsLineAsAWake(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness = withPushAnswering(t, harness, "Aeolus handed a message", 0)

	isHanded, err := harness.HandOver(anEntry(t))

	if want := []string{"Aeolus handed a message " + prompt.NoTerminalQuestions}; err != nil || !isHanded || !slices.Equal(running.sent, want) {
		t.Fatalf("HandOver = %v %v, sent %q, want %q", isHanded, err, running.sent, want)
	}
}

func TestNothingHandedOverStartsNoTurn(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness = withPushAnswering(t, harness, "", 1)

	if isHanded, err := harness.HandOver(anEntry(t)); err != nil || isHanded || len(running.sent) != 0 {
		t.Fatalf("HandOver = %v %v, sent %q, want nothing", isHanded, err, running.sent)
	}
}

func TestAForcedMessageStopsABusyTurnBeforeItsTurnStarts(t *testing.T) {
	for _, test := range []struct {
		isTurnBusy bool
		want       []string
	}{
		{true, []string{"interrupt", "Aeolus forced " + prompt.NoTerminalQuestions}},
		{false, []string{"Aeolus forced " + prompt.NoTerminalQuestions}},
	} {
		harness, running, _ := aHarness(t)
		harness = withPushAnswering(t, harness, "Aeolus forced", 0)

		isHanded, err := harness.ForceOver(anEntry(t), test.isTurnBusy)

		if err != nil || !isHanded || !slices.Equal(running.sent, test.want) {
			t.Fatalf("ForceOver(busy %v) = %v %v, sent %q, want %q", test.isTurnBusy, isHanded, err, running.sent, test.want)
		}
	}
}

func TestAPluginWhoseScriptsAreGoneIsWhyNoSessionCanStart(t *testing.T) {
	harness, _, _ := aHarness(t)
	harness.Plugin.Root = t.TempDir()

	if harness.Problem() == nil {
		t.Fatal("Problem = nil for a plugin with no scripts, want why")
	}
}

func TestASessionNamingMCPServersStartsWithEachAtTheMCPProxyItsFreshTokenInASecretVariable(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.ProxyURL = func() (string, bool) { return "http://127.0.0.1:41000", true }
	entry := anEntry(t)
	entry.McpServers = []string{"company-graph", "notes"}

	for range 2 {
		if err := harness.Launch(entry, true, "launch-1"); err != nil {
			t.Fatal(err)
		}
	}

	first, second := running.started[0], running.started[1]
	servers := []string{
		"-c", `mcp_servers.company-graph={url="http://127.0.0.1:41000/mcp/` + scout + `/company-graph",bearer_token_env_var="AEOLUS_MCP_TOKEN"}`,
		"-c", `mcp_servers.notes={url="http://127.0.0.1:41000/mcp/` + scout + `/notes",bearer_token_env_var="AEOLUS_MCP_TOKEN"}`,
	}
	if want := CommandLine(append([]string{"-m", "gpt-5.6-terra"}, servers...), prompt.First("Review PR 12"), true); !slices.Equal(first.Command, want) {
		t.Fatalf("started %q, want %q", first.Command, want)
	}
	if first.Mcp == nil || first.Mcp.Access.Token == "" || !slices.Equal(first.Mcp.Access.Servers, []string{"company-graph", "notes"}) || first.Mcp.Config != nil {
		t.Fatalf("started with MCP %+v, want a token for company-graph and notes and no configuration file", first.Mcp)
	}
	if first.SecretEnv["AEOLUS_MCP_TOKEN"] != first.Mcp.Access.Token {
		t.Fatalf("secret variables %v, want AEOLUS_MCP_TOKEN with the session's MCP token", first.SecretEnv)
	}
	if second.Mcp == nil || second.Mcp.Access.Token == first.Mcp.Access.Token {
		t.Fatal("the second start has the first one's MCP token, want a fresh one")
	}
	if line := strings.Join(first.Command, " "); strings.Contains(line, first.Mcp.Access.Token) {
		t.Fatalf("the command line %q holds the token", line)
	}
}

func TestASessionNamingNoMCPServerStartsWithNone(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.ProxyURL = func() (string, bool) { return "http://127.0.0.1:41000", true }

	if err := harness.Launch(anEntry(t), true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	started := running.started[0]
	if slices.ContainsFunc(started.Command, func(word string) bool { return strings.Contains(word, "mcp_servers") }) || started.Mcp != nil || started.SecretEnv["AEOLUS_MCP_TOKEN"] != "" {
		t.Fatalf("started %+v, want no MCP server and no MCP token", started)
	}
}

func TestASessionNamingMCPServersDoesNotStartBeforeTheProxyListens(t *testing.T) {
	harness, running, _ := aHarness(t)
	harness.ProxyURL = func() (string, bool) { return "", false }
	entry := anEntry(t)
	entry.McpServers = []string{"company-graph"}

	if err := harness.Launch(entry, true, "launch-1"); err == nil || len(running.started) != 0 {
		t.Fatalf("Launch = %v, started %d, want an error and nothing started", err, len(running.started))
	}
}

func TestCodexCanAddAServerOnlyWhenItsNameHoldsNoDot(t *testing.T) {
	cases := map[string]bool{"company-graph": true, "notes_2": true, "graph.v2": false}
	for name, want := range cases {
		if got := CanAddMcpServer(name); got != want {
			t.Errorf("CanAddMcpServer(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestASessionStartsWithEachServerCodexsConfigurationNamesForItsFolderTurnedOff(t *testing.T) {
	harness, running, _, listed := aHarnessListing(t)
	harness.ProxyURL = func() (string, bool) { return "http://127.0.0.1:41000", true }
	listed.names = []string{"gmail", "dot.ted"}
	entry := anEntry(t)
	entry.McpServers = []string{"company-graph"}

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	flags := []string{
		"-m", "gpt-5.6-terra",
		"-c", `mcp_servers={"dot.ted"={enabled=false},"gmail"={enabled=false}}`,
		"-c", `mcp_servers.company-graph={url="http://127.0.0.1:41000/mcp/` + scout + `/company-graph",bearer_token_env_var="AEOLUS_MCP_TOKEN"}`,
	}
	if want := CommandLine(flags, prompt.First("Review PR 12"), true); !slices.Equal(running.started[0].Command, want) {
		t.Fatalf("started %q, want %q", running.started[0].Command, want)
	}
	if !slices.Equal(listed.askedFrom, []string{entry.Folder}) {
		t.Fatalf("servers listed from %q, want the session's folder", listed.askedFrom)
	}
}

func TestASessionWhoseFolderListsNoServerOfItsOwnTurnsNoneOff(t *testing.T) {
	harness, running, _, listed := aHarnessListing(t)
	listed.names = nil

	if err := harness.Launch(anEntry(t), true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	if want := CommandLine([]string{"-m", "gpt-5.6-terra"}, prompt.First("Review PR 12"), true); !slices.Equal(running.started[0].Command, want) {
		t.Fatalf("started %q, want %q", running.started[0].Command, want)
	}
}

func TestASessionWhoseFoldersServersCannotBeListedStartsNothing(t *testing.T) {
	harness, running, _, listed := aHarnessListing(t)
	listed.err = errors.New("codex app-server did not answer config/read")

	if err := harness.Launch(anEntry(t), true, "launch-1"); err == nil || len(running.started) != 0 {
		t.Fatalf("Launch = %v, started %d, want an error and nothing started, since the session would get the user's servers", err, len(running.started))
	}
}

func TestASessionWhoseFoldersConfigurationNamesAServerAsItsEntryDoesStartsNothing(t *testing.T) {
	harness, running, _, listed := aHarnessListing(t)
	harness.ProxyURL = func() (string, bool) { return "http://127.0.0.1:41000", true }
	listed.names = []string{"gmail", "company-graph"}
	entry := anEntry(t)
	entry.McpServers = []string{"company-graph"}

	err := harness.Launch(entry, true, "launch-1")

	// Codex merges -c into the configuration's own entry, so the session would not get the proxy's company-graph alone.
	if err == nil || len(running.started) != 0 {
		t.Fatalf("Launch = %v, started %d, want an error and nothing started", err, len(running.started))
	}
	if !strings.Contains(err.Error(), "company-graph") || strings.Contains(err.Error(), "gmail") {
		t.Fatalf("Launch = %v, want the cause to name company-graph and no other server of the user's", err)
	}
}

func TestASessionStartsWithEveryPluginCodexsConfigurationEnablesTurnedOffButTheAeolusFleetPlugin(t *testing.T) {
	harness, running, _, listed := aHarnessListing(t)
	listed.plugins = []string{"withmcp@probe-market", "aeolus-fleet@aeolus-fleet", "github@openai-curated"}

	if err := harness.Launch(anEntry(t), true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	flags := []string{"-m", "gpt-5.6-terra", "-c", `plugins={"github@openai-curated"={enabled=false},"withmcp@probe-market"={enabled=false}}`}
	if want := CommandLine(flags, prompt.First("Review PR 12"), true); !slices.Equal(running.started[0].Command, want) {
		t.Fatalf("started %q, want %q, so no plugin's own MCP server loads and the aeolus-fleet plugin's hooks still run", running.started[0].Command, want)
	}
}

func TestTheConfigurationIsReadWithTheLaunchsOwnConfigurationFlags(t *testing.T) {
	harness, running, _, listed := aHarnessListing(t)
	harness.Settings.Flags = []string{"-m", "gpt-5.6-terra", "-c", `mcp_servers.from_flag={command="echo"}`, "--config=features.x=true", "--enable", "y", "--disable=z", "--strict-config", "--skip-git-repo-check"}
	entry := anEntry(t)

	if err := harness.Launch(entry, true, "launch-1"); err != nil {
		t.Fatal(err)
	}

	want := []string{"-c", `mcp_servers.from_flag={command="echo"}`, "--config=features.x=true", "--enable", "y", "--disable=z", "--strict-config"}
	if len(listed.askedWith) != 1 || !slices.Equal(listed.askedWith[0], want) || len(running.started) != 1 {
		t.Fatalf("configuration read with %q, want %q, so a server the launch's flags add is turned off too", listed.askedWith, want)
	}
}

func TestASessionWhoseFlagsPickAProfileOrAnotherFolderStartsNothing(t *testing.T) {
	cases := map[string][]string{
		"-p":         {"-p", "work"},
		"-p joined":  {"-pwork"},
		"--profile":  {"--profile", "work"},
		"--profile=": {"--profile=work"},
		"-C":         {"-C", "/elsewhere"},
		"--cd":       {"--cd", "/elsewhere"},
		"--cd=":      {"--cd=/elsewhere"},
	}
	for name, flags := range cases {
		t.Run(name, func(t *testing.T) {
			harness, running, _, _ := aHarnessListing(t)
			harness.Settings.Flags = flags

			// config/read takes neither a profile, whose own file may name servers, nor another folder, whose project configuration may.
			if err := harness.Launch(anEntry(t), true, "launch-1"); err == nil || len(running.started) != 0 {
				t.Fatalf("Launch with %q = %v, started %d, want an error and nothing started", flags, err, len(running.started))
			}
		})
	}
}
