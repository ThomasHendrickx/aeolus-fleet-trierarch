package cli

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
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

func aMain(t *testing.T) (Machine, *anInstalledService, *aFleet) {
	t.Helper()
	home := t.TempDir()
	at := paths.Of(home, "")
	installed := &anInstalledService{aServiceManager: aServiceManager{write: func() {
		_ = os.WriteFile(at.Running, []byte(`{"pid":41,"version":"`+Version+`"}`), 0o644)
	}}}
	fleet := &aFleet{held: map[string]bool{}}
	return Machine{
		Environ:               []string{"HOME=" + home},
		HomeDirectory:         home,
		Platform:              "linux",
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
		NewPass: func(paths.Paths, crew.File, config.Configuration) (func() error, error) {
			return func() error { return nil }, nil
		},
		PassEvery: time.Millisecond,
		Sessions:  func(paths.Paths) Sessions { return &aSessionRuntime{} },
		Log:       func(string) {},
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
	return []string{"init", "--fleet-url", fleetURL, "--ship-id", shipID, "--secret", secret, "--plugin-ship-id", pluginShipID, "--yes"}
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

func TestStatusSaysTheVersionTheServiceAndTheLease(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)

	output, code := Main([]string{"status", "--json"}, machine)

	want := map[string]any{
		"version":        Version,
		"runningVersion": Version,
		"service":        map[string]any{"file": "/unit", "isInstalled": true, "isRunning": true, "pid": float64(41)},
		"fleet":          map[string]any{"url": fleetURL, "shipId": shipID, "lease": "valid"},
	}
	if got := decoded(t, output); code != 0 || !reflect.DeepEqual(got, want) {
		t.Errorf("answered %v, %d, want %v", got, code, want)
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
