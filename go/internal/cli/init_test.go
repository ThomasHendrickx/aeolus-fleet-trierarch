package cli

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/fleet"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/service"
)

const (
	fleetURL     = "https://fleet.example.com"
	shipID       = "shp_01m6jwb5xwnnezed207ddz58ep"
	otherShipID  = "shp_01m6jwb5xwnnezed207ddz58eq"
	pluginShipID = "shp_01m6jwb5xwnnezed207ddz58er"
	secret       = "aeolus_sk_v1_secret"
)

// aFleet registers each ship once, as core does, and holds the leases of the crew tokens it answered.
type aFleet struct {
	registered []string
	held       map[string]bool
}

func (f *aFleet) register(url string, ship string, given string) (string, error) {
	if url != fleetURL || given != secret {
		return "", &fleet.Refusal{Code: "UNAUTHORIZED", Message: "no such ship or secret"}
	}
	for token, isHeld := range f.held {
		if isHeld && strings.HasPrefix(token, ship) {
			return "", &fleet.Refusal{Code: "CONFLICT", Message: "crewed already"}
		}
	}
	f.registered = append(f.registered, ship)
	token := ship + "-crew-token-" + string(rune('0'+len(f.registered)))
	f.held[token] = true
	return token, nil
}

func (f *aFleet) isLeaseHeld(_ string, token string) (bool, error) {
	return f.held[token], nil
}

// aServiceManager installs and runs the service at once, its process saying its version as it starts.
type aServiceManager struct {
	calls      []string
	installed  bool
	running    bool
	write      func()
	override   *service.Status
	installErr error
}

func (s *aServiceManager) Install() error {
	s.calls = append(s.calls, "install")
	if s.installErr != nil {
		return s.installErr
	}
	s.installed, s.running = true, true
	s.write()
	return nil
}

func (s *aServiceManager) Write() error {
	s.calls = append(s.calls, "write")
	s.installed = true
	return nil
}

func (s *aServiceManager) Rewrite() error {
	s.calls = append(s.calls, "rewrite")
	return nil
}

func (s *aServiceManager) Restart() error {
	s.calls = append(s.calls, "restart")
	s.running = true
	s.write()
	return nil
}

func (s *aServiceManager) Start() error {
	s.calls = append(s.calls, "start")
	s.running = true
	s.write()
	return nil
}

func (s *aServiceManager) Stop() error {
	s.calls = append(s.calls, "stop")
	s.running = false
	return nil
}

func (s *aServiceManager) Status() (service.Status, error) {
	if s.override != nil {
		return *s.override, nil
	}
	if !s.running {
		return service.Status{File: "/unit", IsInstalled: s.installed}, nil
	}
	return service.Status{File: "/unit", IsInstalled: true, IsRunning: true, PID: 41}, nil
}

// aClaudeCode keeps the folders it trusts and whether its onboarding is complete.
type aClaudeCode struct {
	trusted              []string
	isOnboardingComplete bool
}

func (c *aClaudeCode) Trust(folder string) error {
	c.trusted = append(c.trusted, folder)
	return nil
}

func (c *aClaudeCode) CompleteOnboarding() error {
	c.isOnboardingComplete = true
	return nil
}

type aMachine struct {
	elapsed    int
	init       Init
	fleet      *aFleet
	service    *aServiceManager
	claudeCode *aClaudeCode
	plugins    *somePlugins
}

func newMachine(t *testing.T) *aMachine {
	t.Helper()
	home := t.TempDir()
	at := paths.Of(home, "")
	machine := &aMachine{fleet: &aFleet{held: map[string]bool{}}, claudeCode: &aClaudeCode{}, plugins: &somePlugins{versions: map[string]string{}}}
	machine.service = &aServiceManager{write: func() {
		_ = os.MkdirAll(at.Home, 0o700)
		_ = os.WriteFile(at.Running, []byte(`{"pid":41,"version":"0.0.0","firstReportAccepted":true}`), 0o644)
	}}
	machine.init = Init{
		Paths:                 at,
		Platform:              "linux",
		IsClaudeCodeInstalled: true,
		IsClaudeCodeSignedIn:  true,
		ClaudeCode:            machine.claudeCode,
		Service:               machine.service,
		Plugins:               machine.plugins,
		Register:              machine.fleet.register,
		IsLeaseHeld:           machine.fleet.isLeaseHeld,
		Sleep:                 func() { machine.elapsed++ },
		Now:                   func() time.Time { return time.Unix(int64(machine.elapsed), 0) },
		Detect: func([]string, detection.By) (detection.Detected, error) {
			return detection.Detected{}, nil
		},
	}
	return machine
}

func setupLine() Flags {
	return Flags{FleetURL: fleetURL, ShipID: shipID, Secret: secret, PluginShipID: pluginShipID, IsYes: true, Harnesses: []string{"claude-code"}}
}

func TestInitRegistersTheShipAndKeepsItsCrewTokenNeverTheSecret(t *testing.T) {
	machine := newMachine(t)

	if _, err := machine.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}

	kept, err := crew.Read(machine.init.Paths.CrewToken)
	if err != nil {
		t.Fatal(err)
	}
	if want := (crew.File{FleetURL: fleetURL, ShipID: shipID, PluginShipID: pluginShipID, CrewToken: shipID + "-crew-token-1"}); kept != want {
		t.Errorf("kept %+v, want %+v", kept, want)
	}
	if text, _ := os.ReadFile(machine.init.Paths.CrewToken); strings.Contains(string(text), secret) {
		t.Error("the crew file holds the secret")
	}
}

func TestInitWritesTheInitialConfigurationAndItsSchema(t *testing.T) {
	machine := newMachine(t)

	report, err := machine.init.Run(setupLine())

	if err != nil {
		t.Fatal(err)
	}
	if report.Configuration != "written" {
		t.Errorf("configuration %s, want written", report.Configuration)
	}
	written, err := config.Load(machine.init.Paths.Config)
	if err != nil {
		t.Fatal(err)
	}
	if written.Schema != "./config.schema.json" || len(written.Harnesses) != 1 || written.Caps != (config.Caps{Ships: 4, Running: 2}) {
		t.Errorf("wrote %+v", written)
	}
	if _, err := os.Stat(machine.init.Paths.ConfigSchema); err != nil {
		t.Errorf("no schema: %v", err)
	}
}

func TestInitTrustsThePlaceOfShipsAndEachPlaceAndCompletesTheOnboarding(t *testing.T) {
	machine := newMachine(t)
	configuration := config.Initial()
	configuration.Harnesses["claude-code"] = config.Harness{Flags: []string{}, Options: map[string]config.Option{}}
	configuration.Repositories["aeolus-fleet"] = config.Repository{Path: "/src/aeolus-fleet"}
	configuration.Folders["notes"] = config.Folder{Path: "/notes"}
	if err := os.MkdirAll(machine.init.Paths.Home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := config.Write(machine.init.Paths.Config, configuration); err != nil {
		t.Fatal(err)
	}

	if _, err := machine.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}

	want := []string{machine.init.Paths.Ships, "/src/aeolus-fleet", "/notes"}
	if !slices.Equal(machine.claudeCode.trusted, want) {
		t.Errorf("trusted %q, want %q", machine.claudeCode.trusted, want)
	}
	if !machine.claudeCode.isOnboardingComplete {
		t.Error("the onboarding is not complete")
	}
	if info, err := os.Stat(machine.init.Paths.Ships); err != nil || !info.IsDir() {
		t.Errorf("no place of ships/: %v", err)
	}
}

func TestInitInstallsTheServiceAndWaitsForItToSayItsVersion(t *testing.T) {
	machine := newMachine(t)

	report, err := machine.init.Run(setupLine())

	if err != nil {
		t.Fatal(err)
	}
	if report.Service != "installed" || !slices.Equal(machine.service.calls, []string{"install"}) {
		t.Errorf("service %s, calls %q", report.Service, machine.service.calls)
	}
	if slices.Contains(report.Said, notSaidYet) {
		t.Errorf("said %q", report.Said)
	}
}

func TestInitRefusesBeforeItRegistersAnythingWhenClaudeCodeIsNotSignedIn(t *testing.T) {
	machine := newMachine(t)
	machine.init.IsClaudeCodeSignedIn = false

	_, err := machine.init.Run(setupLine())

	if err == nil || !strings.Contains(err.Error(), "installed but not signed in") {
		t.Errorf("err %v", err)
	}
	if len(machine.fleet.registered) != 0 {
		t.Error("registered the ship")
	}
	if _, err := os.Stat(machine.init.Paths.CrewToken); !errors.Is(err, os.ErrNotExist) {
		t.Error("kept a crew file")
	}
}

func TestInitRefusesBeforeItRegistersAnythingWhereClaudeCodeIsNotInstalled(t *testing.T) {
	machine := newMachine(t)
	machine.init.IsClaudeCodeInstalled = false

	if _, err := machine.init.Run(setupLine()); err == nil || len(machine.fleet.registered) != 0 {
		t.Errorf("err %v, registered %q", err, machine.fleet.registered)
	}
}

func TestInitRefusesBeforeItRegistersAnythingWhereSsIsMissing(t *testing.T) {
	machine := newMachine(t)
	machine.init.IsSsMissing = true

	if _, err := machine.init.Run(setupLine()); err == nil || !strings.Contains(err.Error(), "`ss` is not installed") || len(machine.fleet.registered) != 0 {
		t.Errorf("err %v, registered %q", err, machine.fleet.registered)
	}
}

func TestInitOnMacOSRegistersTheShipAndInstallsTheService(t *testing.T) {
	machine := newMachine(t)
	machine.init.Platform = "darwin"

	report, err := machine.init.Run(setupLine())

	if err != nil || len(machine.fleet.registered) != 1 || report.Service != "installed" {
		t.Errorf("Run() = service %q, err %v, registered %q; want installed and registered once", report.Service, err, machine.fleet.registered)
	}
}

func TestInitRefusesBeforeItRegistersAnythingOnASystemWithNeitherLaunchdNorSystemd(t *testing.T) {
	machine := newMachine(t)
	machine.init.Platform = "freebsd"

	if _, err := machine.init.Run(setupLine()); err == nil || !strings.Contains(err.Error(), "knows launchd (macOS) and systemd (Linux), not freebsd") || len(machine.fleet.registered) != 0 {
		t.Errorf("err %v, registered %q", err, machine.fleet.registered)
	}
}

func TestInitNamesTheFlagsItLacks(t *testing.T) {
	machine := newMachine(t)

	_, err := machine.init.Run(Flags{FleetURL: fleetURL, IsYes: true, Harnesses: []string{"claude-code"}})

	if err == nil || !strings.Contains(err.Error(), "--ship-id and --secret are missing") {
		t.Errorf("err %v", err)
	}
}

func TestInitRefusesAShipIDThatIsNone(t *testing.T) {
	machine := newMachine(t)
	flags := setupLine()
	flags.ShipID = "mac-mini"

	if _, err := machine.init.Run(flags); err == nil || !strings.Contains(err.Error(), "mac-mini is no ship id") {
		t.Errorf("err %v", err)
	}
}

func TestInitRefusesAFleetURLThatIsNoHTTPURL(t *testing.T) {
	machine := newMachine(t)
	flags := setupLine()
	flags.FleetURL = "fleet.example.com"

	if _, err := machine.init.Run(flags); err == nil || !strings.Contains(err.Error(), "is no http or https URL") {
		t.Errorf("err %v", err)
	}
}

func TestInitRunAgainWithTheSameSetupLineRegistersNothingAndGoesOn(t *testing.T) {
	machine := newMachine(t)
	if _, err := machine.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}
	machine.service.calls = nil

	report, err := machine.init.Run(setupLine())

	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(machine.fleet.registered, []string{shipID}) {
		t.Errorf("registered %q", machine.fleet.registered)
	}
	if !report.IsSetUpAlready || report.Configuration != "kept" || report.Service != "unchanged" || !slices.Equal(machine.service.calls, []string{"rewrite"}) {
		t.Errorf("report %+v, calls %q", report, machine.service.calls)
	}
}

func TestInitRegistersAgainOnceTheShipWasReleasedAndRestartsTheTrierarch(t *testing.T) {
	machine := newMachine(t)
	if _, err := machine.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}
	machine.fleet.held = map[string]bool{}
	machine.service.calls = nil

	report, err := machine.init.Run(setupLine())

	if err != nil {
		t.Fatal(err)
	}
	kept, _ := crew.Read(machine.init.Paths.CrewToken)
	if kept.CrewToken != shipID+"-crew-token-2" || report.Service != "restarted" || !slices.Equal(machine.service.calls, []string{"rewrite", "restart"}) {
		t.Errorf("kept %+v, report %+v, calls %q", kept, report, machine.service.calls)
	}
}

func TestInitNeverRegistersAnotherShipOnAMachineSetUpAlready(t *testing.T) {
	machine := newMachine(t)
	if _, err := machine.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}
	flags := setupLine()
	flags.ShipID = otherShipID

	_, err := machine.init.Run(flags)

	if err == nil || !strings.Contains(err.Error(), "this machine is set up already") || !slices.Equal(machine.fleet.registered, []string{shipID}) {
		t.Errorf("err %v, registered %q", err, machine.fleet.registered)
	}
}

func TestInitSaysHowToGoOnWhenTheShipIsCrewedElsewhere(t *testing.T) {
	machine := newMachine(t)
	machine.fleet.held[shipID+"-elsewhere"] = true

	_, err := machine.init.Run(setupLine())

	if err == nil || !strings.Contains(err.Error(), "is crewed already") {
		t.Errorf("err %v", err)
	}
}

func TestInitKeepsTheTrierarchPluginsShipOnAMachineSetUpBeforeAndRestartsTheTrierarch(t *testing.T) {
	machine := newMachine(t)
	flags := setupLine()
	flags.PluginShipID = ""
	if _, err := machine.init.Run(flags); err != nil {
		t.Fatal(err)
	}
	machine.service.calls = nil

	report, err := machine.init.Run(Flags{PluginShipID: pluginShipID, IsYes: true, Harnesses: []string{"claude-code"}})

	if err != nil {
		t.Fatal(err)
	}
	kept, _ := crew.Read(filepath.Clean(machine.init.Paths.CrewToken))
	if kept.PluginShipID != pluginShipID || kept.CrewToken != shipID+"-crew-token-1" || report.Service != "restarted" {
		t.Errorf("kept %+v, report %+v", kept, report)
	}
}

func TestInitMakesTheSealingKeyOnlyItsUserReads(t *testing.T) {
	machine := newMachine(t)

	if _, err := machine.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(machine.init.Paths.SealingKey)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the sealing key at %s = %v, %v, want a file of mode 600", machine.init.Paths.SealingKey, info, err)
	}
}

func TestInitRunAgainKeepsTheSealingKey(t *testing.T) {
	machine := newMachine(t)
	if _, err := machine.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(machine.init.Paths.SealingKey)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := machine.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}

	if again, err := os.ReadFile(machine.init.Paths.SealingKey); err != nil || string(again) != string(first) {
		t.Errorf("the sealing key changed on init again (%v): the secrets sealed to it would no longer open", err)
	}
}

func TestInitFailsWhenTheServiceRunsAnotherVersion(t *testing.T) {
	machine := newMachine(t)
	machine.service.write = func() {
		_ = os.MkdirAll(machine.init.Paths.Home, 0o700)
		_ = os.WriteFile(machine.init.Paths.Running, []byte(`{"pid":41,"version":"different"}`), 0o644)
	}

	_, err := machine.init.Run(setupLine())
	if err == nil || !strings.Contains(err.Error(), "version") {
		t.Errorf("Run() error = %v, want a version mismatch", err)
	}
}

func TestInitWaitsForOneProcessForTenSeconds(t *testing.T) {
	machine := newMachine(t)
	waits := 0
	machine.init.Sleep = func() { waits++; machine.elapsed++ }
	if _, err := machine.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}
	if waits != 10 {
		t.Errorf("waited %d seconds, want 10", waits)
	}
}

func TestInitFailsWhenTheServiceCrashesDuringTheWait(t *testing.T) {
	machine := newMachine(t)
	machine.init.Sleep = func() { machine.elapsed++; machine.service.running = false }
	_, err := machine.init.Run(setupLine())
	if err == nil {
		t.Error("Run() succeeded after the service crashed")
	}
}

func TestInitFailsWhenTheLeaseEndsDuringTheWait(t *testing.T) {
	machine := newMachine(t)
	machine.init.Sleep = func() {
		machine.elapsed++
		for token := range machine.fleet.held {
			machine.fleet.held[token] = false
		}
	}
	_, err := machine.init.Run(setupLine())
	if err == nil || !strings.Contains(err.Error(), "lease") {
		t.Errorf("Run() error = %v, want an invalid lease", err)
	}
}

func TestInitFailsWhenTheFirstReportWasNotAccepted(t *testing.T) {
	machine := newMachine(t)
	machine.service.write = func() {
		_ = os.MkdirAll(machine.init.Paths.Home, 0o700)
		_ = os.WriteFile(machine.init.Paths.Running, []byte(`{"pid":41,"version":"0.0.0"}`), 0o644)
	}
	_, err := machine.init.Run(setupLine())
	if err == nil || !strings.Contains(err.Error(), "report") {
		t.Errorf("Run() error = %v, want the missing report", err)
	}
}

func TestInitSaysTheServiceStayedUpAfterTheChecks(t *testing.T) {
	machine := newMachine(t)
	report, err := machine.init.Run(setupLine())
	if err != nil {
		t.Fatal(err)
	}
	text := strings.Join(report.Said, "\n")
	if !strings.Contains(text, "10 seconds") || strings.Contains(text, "The trierarch runs, and starts again") {
		t.Errorf("report = %q, want the checked service", text)
	}
}

func TestInitSaysWhenTheServiceHasNotWrittenItsRunningFile(t *testing.T) {
	machine := newMachine(t)
	machine.service.write = func() {}
	_, err := machine.init.Run(setupLine())
	if err == nil || !strings.Contains(err.Error(), "running.json") {
		t.Errorf("Run() error = %v, want the missing running.json", err)
	}
}

func TestInitRestartsTheTenSecondWaitForANewProcess(t *testing.T) {
	machine := newMachine(t)
	waits := 0
	machine.init.Sleep = func() {
		machine.elapsed++
		waits++
		if waits == 5 {
			machine.service.override = &service.Status{File: "/unit", IsInstalled: true, IsRunning: true, PID: 42, Restarts: 1}
			_ = os.WriteFile(machine.init.Paths.Running, []byte(`{"pid":42,"version":"0.0.0","firstReportAccepted":true}`), 0o644)
		}
	}
	if _, err := machine.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}
	if waits != 15 {
		t.Errorf("waited %d seconds, want 15", waits)
	}
}

func TestInitStopsAfterThirtySecondsOfRestarts(t *testing.T) {
	machine := newMachine(t)
	waits := 0
	machine.init.Sleep = func() {
		machine.elapsed++
		waits++
		pid := 41 + waits/5
		machine.service.override = &service.Status{File: "/unit", IsInstalled: true, IsRunning: true, PID: pid, Restarts: waits / 5}
	}
	machine.init.LastLog = func() string { return "plugin missing" }
	_, err := machine.init.Run(setupLine())
	if waits != 30 || err == nil || !strings.Contains(err.Error(), "restarted 6") || !strings.Contains(err.Error(), "plugin missing") {
		t.Errorf("Run() waited %d seconds, error %v; want six restarts in 30 seconds and the last log", waits, err)
	}
}

func TestInitStartsTheInstalledServiceWhenItIsStopped(t *testing.T) {
	machine := newMachine(t)
	if _, err := machine.init.Run(setupLine()); err != nil {
		t.Fatal(err)
	}
	machine.service.running = false
	if _, err := machine.init.Run(setupLine()); err != nil {
		t.Fatalf("init on a stopped service: %v", err)
	}
	if !machine.service.running {
		t.Error("the service is not running")
	}
}

func TestReportAcceptedWithoutMatchingRunningFile(t *testing.T) {
	for _, contents := range []string{"", `{"pid":42,"version":"old"}`} {
		t.Run(contents, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "running.json")
			if contents != "" {
				if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if err := ReportAccepted(path, 41); err != nil {
				t.Fatalf("ReportAccepted: %v", err)
			}
			got, ok := readRunning(path)
			if !ok || got.PID != 41 || got.Version != Version || !got.FirstReportAccepted {
				t.Errorf("running = %+v, want accepted process 41", got)
			}
		})
	}
}

func TestReportAcceptedReplacesRunningFileAtomically(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "old")
	path := filepath.Join(dir, "running.json")
	if err := os.WriteFile(target, []byte(`{"pid":41,"version":"old"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if err := ReportAccepted(path, 41); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != `{"pid":41,"version":"old"}` {
		t.Errorf("old file = %q, %v; want unchanged", got, err)
	}
}
