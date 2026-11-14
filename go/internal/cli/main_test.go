package cli

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/container"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpconfiguration"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpservers"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/service"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/servicelog"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/state"
)

// anInstalledService is a service that runs as pid 41 once installed, and removes itself on uninstall.
type anInstalledService struct {
	aServiceManager
	uninstalled bool
}

func (s *anInstalledService) Uninstall() error {
	s.uninstalled = true
	s.installed, s.running = false, false
	return nil
}

// aSessionRuntime holds the sessions that run, and stops them as asked.
type aSessionRuntime struct {
	running []string
	stopped []string
}

func (r *aSessionRuntime) List() ([]sessions.Observed, error) {
	observed := []sessions.Observed{}
	for _, shipID := range r.running {
		observed = append(observed, sessions.Observed{ShipID: shipID, Status: "running"})
	}
	return observed, nil
}

func (r *aSessionRuntime) Stop(shipID string) error {
	r.stopped = append(r.stopped, shipID)
	return nil
}

// aShortHome is a home folder as short as a person's, so a ship's socket path under its place of ships/ is within the system's limit,
// as a test's own temporary folder, named after the test, would not be. It sits under /tmp, not under TMPDIR: the release's runner
// points TMPDIR at a folder so long that a ship's socket path passes the limit.
func aShortHome(t *testing.T) string {
	t.Helper()
	home, err := os.MkdirTemp("/tmp", "home")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	return home
}

func aMain(t *testing.T) (Machine, *anInstalledService, *aFleet) {
	t.Helper()
	home := aShortHome(t)
	at := paths.Of(home, "")
	installed := &anInstalledService{aServiceManager: aServiceManager{write: func() {
		_ = os.WriteFile(at.Running, []byte(`{"pid":41,"version":"`+Version+`","firstReportAccepted":true}`), 0o644)
	}}}
	fleet := &aFleet{held: map[string]bool{}}
	return Machine{
		Environ:               []string{"HOME=" + home},
		HomeDirectory:         home,
		Platform:              "linux",
		ManagedSettings:       filepath.Join(home, "managed-settings"),
		PID:                   41,
		IsClaudeCodeInstalled: func() bool { return true },
		IsClaudeCodeSignedIn:  func() bool { return true },
		IsSsMissing:           func() bool { return false },
		ClaudeCode:            func(string, string) ClaudeCode { return &aClaudeCode{} },
		IsCodexInstalled:      func() bool { return false },
		IsCodexSignedIn:       func() bool { return false },
		Codex:                 func() Codex { return &aCodex{} },
		Service:               func(paths.Paths) ServiceManager { return installed },
		Register:              fleet.register,
		IsLeaseHeld:           fleet.isLeaseHeld,
		Sleep:                 func() {},
		Stop:                  make(chan struct{}),
		CoreVersionRefusal:    func(string) string { return "" },
		ContainerHost:         func(string) container.Host { return aRuntime{} },
		NewPass: func(paths.Paths, crew.File, config.Configuration) (func(isKeyCutOff bool) error, error) {
			return func(bool) error { return nil }, nil
		},
		PassEvery: time.Millisecond,
		Sessions:  func(paths.Paths) Sessions { return &aSessionRuntime{} },
		Plugins:   func() Plugins { return &somePlugins{versions: map[string]string{"claude-code": "0.20.4"}} },
		StartedAt: func(int) string { return "2026-10-06T07:00:00.000Z" },
		Log:       func(string) {},
		Detect: func(paths.Paths, []string, detection.By) (detection.Detected, error) {
			return detection.Detected{}, nil
		},
	}, installed, fleet
}

func decoded(t *testing.T, output string) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal([]byte(output), &value); err != nil {
		t.Fatalf("%q is no JSON object: %v", output, err)
	}
	return value
}

func setupWords() []string {
	return []string{"init", "--fleet-url", fleetURL, "--ship-id", shipID, "--secret", secret, "--plugin-ship-id", pluginShipID, "--harnesses", "claude-code", "--yes"}
}

func TestSaysItsVersion(t *testing.T) {
	machine, _, _ := aMain(t)

	output, code := Main([]string{"--version", "--json"}, machine)

	if code != 0 || !reflect.DeepEqual(decoded(t, output), map[string]any{"version": Version}) {
		t.Errorf("answered %q, %d", output, code)
	}
	if output, _ := Main([]string{"-v"}, machine); output != Version {
		t.Errorf("-v answered %q", output)
	}
}

func TestACommandItDoesNotKnowGetsTheUsage(t *testing.T) {
	machine, _, _ := aMain(t)

	output, code := Main([]string{"sail"}, machine)

	if code != 2 || !strings.HasPrefix(output, "Usage: aeolus-trierarch") {
		t.Errorf("answered %q, %d", output, code)
	}
}

func TestInitSaysWhatItDidAndWhatItRefuses(t *testing.T) {
	machine, _, _ := aMain(t)

	output, code := Main(setupWords(), machine)

	if code != 0 || !strings.Contains(output, "Registered "+shipID) {
		t.Errorf("answered %q, %d", output, code)
	}
	machine.IsClaudeCodeSignedIn = func() bool { return false }
	if output, code := Main(append(setupWords(), "--json"), machine); code != 1 || !strings.Contains(decoded(t, output)["error"].(string), "not signed in") {
		t.Errorf("answered %q, %d", output, code)
	}
}

func TestInitAnswersItsReportAsJSON(t *testing.T) {
	machine, _, _ := aMain(t)

	output, code := Main(append(setupWords(), "--json"), machine)

	report := decoded(t, output)
	if code != 0 || report["shipId"] != shipID || report["service"] != "installed" || report["configuration"] != "written" {
		t.Errorf("answered %q, %d", output, code)
	}
}

func TestStatusSaysTheWholeState(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	at := paths.Of(machine.HomeDirectory, "")
	configuration, _ := config.Load(at.Config)
	configuration.Repositories["aeolus-fleet"] = config.Repository{Path: "/repository"}
	configuration.Harnesses["codex"] = config.Harness{Flags: []string{}, Options: map[string]config.Option{}}
	_ = config.Write(at.Config, configuration)
	machine.Sessions = func(paths.Paths) Sessions { return &aSessionRuntime{running: []string{"shp_a"}} }
	saved := reconciler.Empty()
	saved.Entries["shp_a"] = reconciler.Entry{ShipID: "shp_a", State: "running"}
	saved.Entries["shp_b"] = reconciler.Entry{ShipID: "shp_b", State: "restarting"}
	saved.Kept = []any{map[string]any{"shipId": "shp_k", "repository": "aeolus-fleet", "path": "/worktrees/kept"}}
	saved.Orphans = []any{map[string]any{"path": "/worktrees/stray", "repository": "aeolus-fleet", "name": "stray"}}
	saved.PassFailure = &reconciler.PassFailure{Reason: "the fleet cannot be reached", Since: "2026-10-06T08:00:00.000Z"}
	_ = state.File{Path: at.State}.Save(saved)
	confirmedAt := "2026-11-08T07:30:00.000Z"
	_ = detection.File{Path: at.Detected}.Save(detection.Detected{"claude-code": {Version: "2.1.306", DetectedAt: confirmedAt, ConfirmedAt: &confirmedAt, Options: map[string]config.Option{}}, "codex": {Version: "0.163.0", DetectedAt: confirmedAt, Options: map[string]config.Option{}}})

	output, code := Main([]string{"status"}, machine)

	want := strings.Join([]string{
		"Version: " + Version,
		"Aeolus Fleet plugin: claude-code 0.20.4, codex not found (install the aeolus-fleet plugin for it)",
		"Models confirmed: claude-code 2026-11-08T07:30:00.000Z, codex never",
		"Repositories: aeolus-fleet",
		"Service: running, pid 41, since 2026-10-06T07:00:00.000Z",
		"Fleet: " + fleetURL + ", the lease of " + shipID + " is valid",
		"Caps: 2 of 4 ships crewed here, 1 of 2 sessions running",
		"Last pass: failing since 2026-10-06T08:00:00.000Z: the fleet cannot be reached",
		"Entries: running 1, restarting 1",
		"Kept worktrees: /worktrees/kept (shp_k)",
		"Orphans: /worktrees/stray",
	}, "\n")
	if code != 0 || output != want {
		t.Errorf("answered %q, %d, want %q", output, code, want)
	}
}

func TestStatusAnswersTheReportAsJSON(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)

	output, code := Main([]string{"status", "--json"}, machine)

	want := map[string]any{
		"version":           Version,
		"runningVersion":    Version,
		"plugins":           map[string]any{"claude-code": "0.20.4"},
		"modelsConfirmedAt": map[string]any{"claude-code": nil},
		"repositories":      []any{},
		"service":           map[string]any{"file": "/unit", "isInstalled": true, "isRunning": true, "pid": float64(41), "since": "2026-10-06T07:00:00.000Z"},
		"fleet":             map[string]any{"url": fleetURL, "shipId": shipID, "lease": "valid"},
		"caps":              map[string]any{"ships": map[string]any{"used": float64(0), "cap": float64(4)}, "running": map[string]any{"used": float64(0), "cap": float64(2)}},
		"entries":           map[string]any{"crewing": float64(0), "running": float64(0), "restarting": float64(0), "crashed": float64(0), "releasing": float64(0)},
		"kept":              []any{},
		"orphans":           []any{},
	}
	if got := decoded(t, output); code != 0 || !reflect.DeepEqual(got, want) {
		t.Errorf("answered %v, %d, want %v", got, code, want)
	}
}

func TestStatusSaysWhenTheServiceRunsAnotherVersionThanIsInstalled(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	at := paths.Of(machine.HomeDirectory, "")
	for running, want := range map[string]string{
		`{"pid":41,"version":"0.17.4"}`: "0.0.0 installed, 0.17.4 running: restart the service to run the installed one (aeolus-trierarch restart)",
		`{"pid":7,"version":"0.0.0"}`:   "0.0.0 installed, the running service did not say its version, so it started before 0.0.0: restart it to run the installed one (aeolus-trierarch restart)",
	} {
		_ = os.WriteFile(at.Running, []byte(running), 0o644)

		output, _ := Main([]string{"status"}, machine)

		if line := strings.Split(output, "\n")[0]; line != "Version: "+want {
			t.Errorf("%s: %q", running, line)
		}
	}
}

func TestStatusSaysWhenTheServiceIsNotInstalledOrNotRunning(t *testing.T) {
	machine, installed, _ := aMain(t)
	Main(setupWords(), machine)

	installed.running = false
	if output, _ := Main([]string{"status"}, machine); !strings.Contains(output, "Service: installed, not running (aeolus-trierarch start)\n") {
		t.Errorf("answered %q", output)
	}
	installed.installed = false
	if output, _ := Main([]string{"status"}, machine); !strings.Contains(output, "Service: not installed (aeolus-trierarch install)\n") {
		t.Errorf("answered %q", output)
	}
}

func TestStatusColoursItsWordsOnAColourTerminalAndNotUnderJSON(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	plain, _ := Main([]string{"status"}, machine)
	machine.IsTerminal = true

	coloured, _ := Main([]string{"status"}, machine)
	machine.Environ = append(machine.Environ, "NO_COLOR=1")
	refused, _ := Main([]string{"status"}, machine)
	machine.Environ = append(machine.Environ, "FORCE_COLOR=1")
	asJSON, _ := Main([]string{"status", "--json"}, machine)

	if !strings.Contains(coloured, "\x1b[1mVersion:\x1b[22m") || !strings.Contains(coloured, "\x1b[32mrunning\x1b[39m") {
		t.Errorf("answered %q", coloured)
	}
	if stripped := regexp.MustCompile("\x1b\\[[0-9;]*m").ReplaceAllString(coloured, ""); stripped != plain {
		t.Errorf("coloured says %q, plain says %q", stripped, plain)
	}
	if refused != plain || strings.Contains(asJSON, "\x1b") {
		t.Errorf("NO_COLOR gave %q, --json %q", refused, asJSON)
	}
}

func TestListColoursItsHeaderAndStatesOnAColourTerminal(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	at := paths.Of(machine.HomeDirectory, "")
	saved := reconciler.Empty()
	saved.Entries["shp_a"] = reconciler.Entry{ShipID: "shp_a", State: "running", Harness: "claude-code", Workspace: reconciler.Workspace{Kind: "folder", Name: "scratch"}, Since: "2026-10-06T08:00:00.000Z"}
	_ = state.File{Path: at.State}.Save(saved)
	plain, _ := Main([]string{"list"}, machine)
	machine.IsTerminal = true

	coloured, _ := Main([]string{"list"}, machine)

	if !strings.HasPrefix(coloured, "\x1b[1mSHIP") || !strings.Contains(coloured, "\x1b[32mrunning\x1b[39m") {
		t.Errorf("answered %q", coloured)
	}
	if stripped := regexp.MustCompile("\x1b\\[[0-9;]*m").ReplaceAllString(coloured, ""); stripped != plain {
		t.Errorf("coloured says %q, plain says %q", stripped, plain)
	}
}

func TestStatusSaysAnEndedLease(t *testing.T) {
	machine, _, fleet := aMain(t)
	Main(setupWords(), machine)
	fleet.held = map[string]bool{}

	output, _ := Main([]string{"status", "--json"}, machine)

	if lease := decoded(t, output)["fleet"].(map[string]any)["lease"]; lease != "ended" {
		t.Errorf("lease %v", lease)
	}
}

func TestRunSaysItsPidAndVersionAndEndsWhenStopped(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	stop := make(chan struct{})
	machine.Stop = stop
	close(stop)

	output, code := Main([]string{"run"}, machine)

	if code != 0 || output != "aeolus-trierarch stopped." {
		t.Errorf("answered %q, %d", output, code)
	}
	running, isRead := readRunning(filepath.Join(machine.HomeDirectory, ".aeolus", "trierarch", "running.json"))
	if !isRead || running != (Running{PID: 41, Version: Version}) {
		t.Errorf("running.json says %+v", running)
	}
}

func TestRunMakesTheSealingKeyOfAMachineSetUpBeforeThereWasOne(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	at := paths.Of(machine.HomeDirectory, "")
	if err := os.Remove(at.SealingKey); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	machine.Stop = stop
	close(stop)

	if output, code := Main([]string{"run"}, machine); code != 0 {
		t.Fatalf("run answered %q, %d", output, code)
	}

	if info, err := os.Stat(at.SealingKey); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("the sealing key = %v, %v, want a file of mode 600", info, err)
	}
}

// anMcpFleet is the trierarch's own ship in the fleet, as the MCP configuration asks it.
type anMcpFleet struct{ fleetID string }

func (f anMcpFleet) FleetID() (string, error) { return f.fleetID, nil }

func (anMcpFleet) ConfirmMcpConfiguration(string, string) error { return nil }

// runHoldingMcpConfiguration runs the trierarch of a fleet once, with the MCP configuration of the plugin ship persisted, and answers what the file holds at its first pass.
func runHoldingMcpConfiguration(t *testing.T, persistedFor mcpconfiguration.Identity) (mcpconfiguration.Configuration, bool) {
	t.Helper()
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	at := paths.Of(machine.HomeDirectory, "")
	persisted := &mcpconfiguration.File{Path: at.McpConfiguration}
	persisted.Load(persistedFor)
	if _, err := persisted.Apply(mcpconfiguration.Configuration{Identity: persistedFor, Version: 3, PublicKey: "key-a", Servers: []mcpservers.Server{}, Secrets: map[string]string{}}); err != nil {
		t.Fatal(err)
	}
	held := &mcpconfiguration.File{Path: at.McpConfiguration}
	machine.McpConfiguration = func(paths.Paths) *mcpconfiguration.File { return held }
	machine.McpFleet = func(crew.File) McpFleet { return anMcpFleet{fleetID: "flt_01m3tb1zgr5h2ffee12xnch8sv"} }
	var atFirstPass mcpconfiguration.Configuration
	var isHeld bool
	stop := make(chan struct{})
	machine.Stop = stop
	machine.NewPass = func(paths.Paths, crew.File, config.Configuration) (func(isKeyCutOff bool) error, error) {
		return func(bool) error {
			atFirstPass, isHeld = held.Current()
			close(stop)
			return nil
		}, nil
	}

	if output, code := Main([]string{"run"}, machine); code != 0 {
		t.Fatalf("run answered %q, %d", output, code)
	}
	return atFirstPass, isHeld
}

func TestRunHoldsThePersistedMcpConfigurationOfItsFleetAndPluginShipFromItsFirstPass(t *testing.T) {
	held, ok := runHoldingMcpConfiguration(t, mcpconfiguration.Identity{FleetID: "flt_01m3tb1zgr5h2ffee12xnch8sv", PluginShipID: pluginShipID})

	if !ok || held.Version != 3 {
		t.Errorf("at the first pass the file holds %+v, %v, want version 3", held, ok)
	}
}

func TestRunClearsAnMcpConfigurationOfAnotherFleetBeforeItsFirstPass(t *testing.T) {
	held, ok := runHoldingMcpConfiguration(t, mcpconfiguration.Identity{FleetID: "flt_01m3tb1zgr5h2ffee12xnch8sw", PluginShipID: pluginShipID})

	if ok {
		t.Errorf("at the first pass the file holds %+v, want none", held)
	}
}

func TestRunClearsTheAppliedMcpConfigurationWhenNoPluginShipIsConfigured(t *testing.T) {
	machine, _, _ := aMain(t)
	var words []string
	for index, word := range setupWords() {
		if word == "--plugin-ship-id" || (index > 0 && setupWords()[index-1] == "--plugin-ship-id") {
			continue
		}
		words = append(words, word)
	}
	if output, code := Main(words, machine); code != 0 {
		t.Fatalf("init answered %q, %d", output, code)
	}
	at := paths.Of(machine.HomeDirectory, "")
	identity := mcpconfiguration.Identity{FleetID: "flt_01m3tb1zgr5h2ffee12xnch8sv", PluginShipID: pluginShipID}
	persisted := &mcpconfiguration.File{Path: at.McpConfiguration}
	persisted.Load(identity)
	if _, err := persisted.Apply(mcpconfiguration.Configuration{Identity: identity, Version: 3, PublicKey: "key-a", Servers: []mcpservers.Server{}, Secrets: map[string]string{}}); err != nil {
		t.Fatal(err)
	}
	machine.McpConfiguration = func(paths.Paths) *mcpconfiguration.File { return &mcpconfiguration.File{Path: at.McpConfiguration} }
	machine.McpFleet = func(crew.File) McpFleet { return anMcpFleet{fleetID: identity.FleetID} }
	stop := make(chan struct{})
	machine.Stop = stop
	close(stop)

	if output, code := Main([]string{"run"}, machine); code != 0 {
		t.Fatalf("run answered %q, %d", output, code)
	}

	if held, ok := mcpconfiguration.ReadFile(at.McpConfiguration); ok {
		t.Errorf("after run without a plugin ship the file holds %+v, want none, so the proxy refuses every bound session", held)
	}
}

func TestRunRemovesTheSupersededMcpAndAipFilesAndLeavesTheUsersOwnAip(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	home := filepath.Join(machine.HomeDirectory, ".aeolus", "trierarch")
	superseded := []string{"mcp-servers.json", "secrets.json", "aip.json", "aip-command.json", "aip-command.lock", filepath.Join("aip-command", "venv", "bin", "aip")}
	users := filepath.Join(machine.HomeDirectory, ".local", "bin", "aip")
	for _, path := range append([]string{users}, superseded...) {
		if !filepath.IsAbs(path) {
			path = filepath.Join(home, path)
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	stop := make(chan struct{})
	machine.Stop = stop
	close(stop)

	if output, code := Main([]string{"run"}, machine); code != 0 {
		t.Fatalf("run answered %q, %d", output, code)
	}

	for _, name := range []string{"mcp-servers.json", "secrets.json", "aip.json", "aip-command.json", "aip-command.lock", "aip-command"} {
		if _, err := os.Lstat(filepath.Join(home, name)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s after run: %v, want it removed", name, err)
		}
	}
	if _, err := os.Stat(users); err != nil {
		t.Errorf("the user's own aip after run: %v, want it left", err)
	}
}

func TestRunSaysALeftoverAipInTheConfigurationIsNoLongerUsed(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	at := paths.Of(machine.HomeDirectory, "")
	text, err := os.ReadFile(at.Config)
	if err != nil {
		t.Fatal(err)
	}
	withAip := strings.Replace(string(text), "{", `{"aip":{"server":"https://aip.example.invalid","tokenSecret":"aip-read"},`, 1)
	if err := os.WriteFile(at.Config, []byte(withAip), 0o644); err != nil {
		t.Fatal(err)
	}
	logged := []string{}
	machine.Log = func(line string) { logged = append(logged, line) }
	stop := make(chan struct{})
	machine.Stop = stop
	close(stop)

	if output, code := Main([]string{"run"}, machine); code != 0 {
		t.Fatalf("run answered %q, %d", output, code)
	}

	want := "The configuration's aip is no longer used: a fleet adds aip as an MCP server of its own; remove it from " + at.Config
	if !slices.Contains(logged, want) {
		t.Errorf("logged %q, want %q", logged, want)
	}
}

func TestUninstallRemovesTheServiceAndKeepsTheTrierarchsFiles(t *testing.T) {
	machine, installed, _ := aMain(t)
	Main(setupWords(), machine)

	output, code := Main([]string{"uninstall"}, machine)

	if code != 0 || !installed.uninstalled || !strings.Contains(output, "Removed the service") {
		t.Errorf("answered %q, %d", output, code)
	}
	if _, err := crew.Read(filepath.Join(machine.HomeDirectory, ".aeolus", "trierarch", "crew-token")); err != nil {
		t.Errorf("the crew file is gone: %v", err)
	}
}

func TestTheConfigurationMovesWithAeolusTrierarchConfig(t *testing.T) {
	machine, _, _ := aMain(t)
	moved := filepath.Join(machine.HomeDirectory, "elsewhere.json")
	machine.Environ = append(machine.Environ, "AEOLUS_TRIERARCH_CONFIG="+moved)

	Main(setupWords(), machine)

	if _, err := os.Stat(moved); err != nil {
		t.Errorf("no configuration at %s: %v", moved, err)
	}
}

func TestTheProxyTakesItsOwnWords(t *testing.T) {
	machine, _, _ := aMain(t)

	if _, code := Main([]string{"proxy", "--folder", t.TempDir()}, machine); code != 2 {
		t.Errorf("proxy without its folders answered %d, want 2", code)
	}
}

func TestConfigCheckAcceptsTheConfigurationThisVersionRunsOn(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)

	output, code := Main([]string{"config", "check", "--json"}, machine)

	if code != 0 || decoded(t, output)["path"] != filepath.Join(machine.HomeDirectory, ".aeolus", "trierarch", "config.json") {
		t.Errorf("config check answered %q, %d, want the configuration accepted", output, code)
	}
}

func TestConfigCheckRefusesAConfigurationThisVersionDoesNotRunOn(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	file := filepath.Join(machine.HomeDirectory, ".aeolus", "trierarch", "config.json")
	if err := os.WriteFile(file, []byte(`{"caps":{},"repositories":{},"folders":{},"harnesses":{},"model":"opus"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	output, code := Main([]string{"config", "check", "--json"}, machine)

	if code != 1 || !strings.Contains(decoded(t, output)["error"].(string), "model") {
		t.Errorf("config check answered %q, %d, want it refused naming the key", output, code)
	}
}

func TestUpgradeAnswersItsReportAndExitsOneWhenThePluginIsNotUpdated(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	plugins := &somePlugins{versions: map[string]string{}}
	machine.Plugins = func() Plugins { return plugins }
	machine.Releases = func() Releases { return &someReleases{latest: Version} }
	machine.Program = filepath.Join(machine.HomeDirectory, "aeolus-trierarch")

	output, code := Main([]string{"upgrade", Version, "--json"}, machine)

	report := decoded(t, output)
	if code != 0 || report["from"] != Version || report["isUpgraded"] != false || report["isPluginUpdated"] != true {
		t.Errorf("upgrade answered %q, %d, want on %s, the plugin updated", output, code, Version)
	}
	plugins.failing = errors.New("claude plugin marketplace update aeolus-fleet failed: Failed to reach the marketplace")
	if output, code := Main([]string{"upgrade", "--json"}, machine); code != 1 || decoded(t, output)["isPluginUpdated"] != false {
		t.Errorf("upgrade with the plugin failing answered %q, %d, want exit 1", output, code)
	}
}

func TestInitSaysTheLastLogLineWhenTheServiceCrashes(t *testing.T) {
	machine, manager, _ := aMain(t)
	machine.Sleep = func() { manager.running = false }
	machine.ServiceLog = func(paths.Paths) servicelog.Log {
		return servicelog.Log{Tail: func(int) ([]string, error) { return []string{"plugin missing"}, nil }}
	}
	output, code := Main(setupWords(), machine)
	if code != 1 || !strings.Contains(output, "plugin missing") {
		t.Errorf("init = %q, %d; want the last log line and exit 1", output, code)
	}
}

func TestStatusSaysTheRestartCountAndLastError(t *testing.T) {
	machine, manager, _ := aMain(t)
	if output, code := Main(setupWords(), machine); code != 0 {
		t.Fatalf("init = %q, %d", output, code)
	}
	manager.override = &service.Status{File: "/unit", IsInstalled: true, IsRestarting: true, Restarts: 6}
	machine.ServiceLog = func(paths.Paths) servicelog.Log {
		return servicelog.Log{Tail: func(int) ([]string, error) { return []string{"plugin missing"}, nil }}
	}
	output, code := Main([]string{"status"}, machine)
	if code != 0 || !strings.Contains(output, "restarted 6") || !strings.Contains(output, "plugin missing") {
		t.Errorf("status = %q, %d; want restart count and last error", output, code)
	}
}

func TestStatusShowsWhenTheFirstReportHasNotBeenAccepted(t *testing.T) {
	machine, _, _ := aMain(t)
	if output, code := Main(setupWords(), machine); code != 0 {
		t.Fatalf("init = %q, %d", output, code)
	}
	at := paths.Of(machine.HomeDirectory, "")
	if err := os.WriteFile(at.Running, []byte(`{"pid":41,"version":"0.0.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	output, code := Main([]string{"status"}, machine)
	if code != 0 || !strings.Contains(output, "first report") {
		t.Errorf("status = %q, %d; want the missing first report", output, code)
	}
}

func TestStatusShowsWhenTheProcessHasNotRunForTenSeconds(t *testing.T) {
	machine, _, _ := aMain(t)
	if output, code := Main(setupWords(), machine); code != 0 {
		t.Fatalf("init = %q, %d", output, code)
	}
	machine.StartedAt = func(int) string { return time.Now().UTC().Format(time.RFC3339) }
	output, code := Main([]string{"status"}, machine)
	if code != 0 || !strings.Contains(output, "10 seconds") {
		t.Errorf("status = %q, %d; want the ten-second wait", output, code)
	}
}

func TestStatusShowsTheLoopWhileItsLatestProcessIsRunning(t *testing.T) {
	machine, manager, _ := aMain(t)
	if output, code := Main(setupWords(), machine); code != 0 {
		t.Fatalf("init = %q, %d", output, code)
	}
	manager.override = &service.Status{File: "/unit", IsInstalled: true, IsRunning: true, PID: 41, Restarts: 6}
	machine.StartedAt = func(int) string { return time.Now().UTC().Format(time.RFC3339) }
	machine.ServiceLog = func(paths.Paths) servicelog.Log {
		return servicelog.Log{Tail: func(int) ([]string, error) { return []string{"plugin missing"}, nil }}
	}
	output, code := Main([]string{"status"}, machine)
	if code != 0 || !strings.Contains(output, "restarted 6") || !strings.Contains(output, "plugin missing") {
		t.Errorf("status = %q, %d; want the loop and last error", output, code)
	}
}

func TestInitSaysTheLastLogLineWhenTheServiceFailsToStart(t *testing.T) {
	machine, manager, _ := aMain(t)
	manager.installErr = errors.New("service start failed")
	machine.ServiceLog = func(paths.Paths) servicelog.Log {
		return servicelog.Log{Tail: func(int) ([]string, error) { return []string{"plugin missing"}, nil }}
	}
	output, code := Main(setupWords(), machine)
	if code != 1 || !strings.Contains(output, "service start failed") || !strings.Contains(output, "plugin missing") {
		t.Errorf("init = %q, %d; want the failure and last log line", output, code)
	}
}

func TestStatusShowsWhenTheProcessAgeIsUnknown(t *testing.T) {
	machine, _, _ := aMain(t)
	if output, code := Main(setupWords(), machine); code != 0 {
		t.Fatalf("init = %q, %d", output, code)
	}
	machine.StartedAt = func(int) string { return "" }
	output, code := Main([]string{"status"}, machine)
	if code != 0 || !strings.Contains(output, "cannot determine") {
		t.Errorf("status = %q, %d; want the unknown process age", output, code)
	}
}
