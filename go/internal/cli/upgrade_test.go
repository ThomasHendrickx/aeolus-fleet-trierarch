package cli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/service"
)

// The binaries of these tests are a line saying the version they run: aServiceOf starts what the file at the program says, and anInstalled runs it.
const (
	running   = "0.40.0"
	released  = "0.41.0"
	noStart   = "starts no trierarch"
	noVersion = "says no version"
)

func binaryOf(version string) []byte {
	return []byte("aeolus-trierarch " + version + "\n")
}

// someReleases are the GitHub Releases as Fetch takes them: a binary per version, or the reason it takes none.
type someReleases struct {
	latest  string
	refusal error
	fetched []string
}

func (r *someReleases) Latest() (string, error) { return r.latest, nil }

func (r *someReleases) Fetch(version string) ([]byte, error) {
	r.fetched = append(r.fetched, version)
	if r.refusal != nil {
		return nil, r.refusal
	}
	return binaryOf(version), nil
}

// aServiceOf is the service as systemd runs it: a restart runs the file at the program, which says its version in running.json with a new pid, unless it starts no trierarch.
type aServiceOf struct {
	program   string
	running   string
	pid       int
	installed bool
	restarts  []string
	rewrites  int
}

func (s *aServiceOf) Install() error { s.installed = true; return s.Restart() }
func (s *aServiceOf) Rewrite() error { s.rewrites++; return nil }
func (s *aServiceOf) Start() error   { return s.Restart() }
func (s *aServiceOf) Stop() error    { s.pid = 0; return nil }
func (s *aServiceOf) Uninstall() error {
	s.installed = false
	return nil
}

func (s *aServiceOf) Restart() error {
	text, err := os.ReadFile(s.program)
	if err != nil {
		return err
	}
	version := strings.TrimSpace(strings.TrimPrefix(string(text), "aeolus-trierarch "))
	s.restarts = append(s.restarts, version)
	s.pid += 100
	if version == noStart {
		return nil
	}
	return os.WriteFile(s.running, []byte(fmt.Sprintf(`{"pid":%d,"version":%q}`, s.pid, version)), 0o644)
}

func (s *aServiceOf) Status() (service.Status, error) {
	return service.Status{IsInstalled: s.installed, IsRunning: s.installed && s.pid != 0, PID: s.pid, File: "aeolus-trierarch.service"}, nil
}

// somePlugins update the aeolus-fleet plugin of each harness from the tag, Claude Code's from 0.40.0 to the tag's version, or to the version kept when one is.
type somePlugins struct {
	failing  error
	updates  []string
	versions map[string]string
	kept     map[string]string
}

func (p *somePlugins) Update(harness string, tag string) error {
	p.updates = append(p.updates, harness+" "+tag)
	if p.failing != nil {
		return p.failing
	}
	p.versions[harness] = strings.TrimPrefix(tag, "v")
	if kept := p.kept[harness]; kept != "" {
		p.versions[harness] = kept
	}
	return nil
}

func (p *somePlugins) Version(harness string) string { return p.versions[harness] }

type anUpgrade struct {
	upgrade  Upgrade
	releases *someReleases
	service  *aServiceOf
	plugins  *somePlugins
	codex    *aCodex
	// ran are the words each run of an installed file was given, with its version.
	ran []string
}

// anUpgradeOn is a machine whose trierarch runs 0.40.0 from ~/.local/bin/aeolus-trierarch as a service, Claude Code on offer.
func anUpgradeOn(t *testing.T) *anUpgrade {
	t.Helper()
	home := t.TempDir()
	at := paths.Of(home, "")
	program := filepath.Join(home, ".local", "bin", "aeolus-trierarch")
	if err := os.MkdirAll(filepath.Dir(program), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(program, binaryOf(running), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(at.Home, 0o700); err != nil {
		t.Fatal(err)
	}
	machine := &anUpgrade{
		releases: &someReleases{latest: released},
		service:  &aServiceOf{program: program, running: at.Running, installed: true},
		plugins:  &somePlugins{versions: map[string]string{"claude-code": running}},
		codex:    &aCodex{},
	}
	if err := machine.service.Restart(); err != nil {
		t.Fatal(err)
	}
	machine.upgrade = Upgrade{
		Paths:      at,
		Version:    running,
		Program:    program,
		Harnesses:  []string{"claude-code"},
		Releases:   machine.releases,
		Service:    machine.service,
		Plugins:    machine.plugins,
		Codex:      machine.codex,
		HookFolder: at.Worktrees,
		Sleep:      func() {},
		Trierarch: func(file string, isPluginStep bool, words ...string) (string, int) {
			text, err := os.ReadFile(file)
			if err != nil {
				return err.Error(), 127
			}
			version := strings.TrimSpace(strings.TrimPrefix(string(text), "aeolus-trierarch "))
			// It runs as a command, and only its service starts no trierarch.
			if version == noStart {
				version = released
			}
			machine.ran = append(machine.ran, version+" "+strings.Join(words, " "))
			switch {
			case version == noVersion:
				return "exec format error", 126
			case slices.Equal(words, []string{"--version", "--json"}):
				return fmt.Sprintf(`{"version":%q}`, version), 0
			case words[0] == "config":
				return `{"path":"config.json"}`, 0
			case words[0] == "upgrade" && isPluginStep:
				return fmt.Sprintf(`{"from":%q,"to":%q,"isUpgraded":false,"isPluginUpdated":true,"said":["The trierarch is already on %s.","Updated the aeolus-fleet plugin for Claude Code from %s to %s."]}`, version, version, version, running, version), 0
			}
			return "no such words", 2
		},
	}
	return machine
}

func (m *anUpgrade) program(t *testing.T) string {
	t.Helper()
	text, err := os.ReadFile(m.upgrade.Program)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func TestUpgradeOnTheVersionItRunsInstallsNothingAndUpdatesThePluginFromItsReleaseTag(t *testing.T) {
	machine := anUpgradeOn(t)

	report, err := machine.upgrade.Run(running)

	if err != nil || report.From != running || report.To != running || report.IsUpgraded || !report.IsPluginUpdated {
		t.Fatalf("Run(%s) = %+v, %v, want on %s, the plugin updated", running, report, err, running)
	}
	if !slices.Equal(machine.plugins.updates, []string{"claude-code v" + running}) {
		t.Errorf("plugin updates = %v, want claude-code from v%s", machine.plugins.updates, running)
	}
	if len(machine.releases.fetched) != 0 || len(machine.service.restarts) != 1 {
		t.Errorf("fetched %v and restarted %v, want nothing", machine.releases.fetched, machine.service.restarts[1:])
	}
	if !slices.Contains(report.Said, "The trierarch is already on 0.40.0.") {
		t.Errorf("said %q, want it on 0.40.0 already", report.Said)
	}
	if _, err := os.Stat(machine.upgrade.Paths.ConfigSchema); err != nil {
		t.Errorf("config.schema.json: %v, want it written for the version", err)
	}
}

func TestUpgradeSaysAPluginItCouldNotUpdateAndTheServiceKeepsRunning(t *testing.T) {
	machine := anUpgradeOn(t)
	machine.plugins.failing = errors.New("claude plugin marketplace update aeolus-fleet failed: Failed to reach the marketplace")

	report, err := machine.upgrade.Run(running)

	if err != nil || report.IsPluginUpdated || machine.service.pid != 100 {
		t.Fatalf("Run(the plugin failing) = %+v, %v with pid %d, want the plugin not updated and pid 100", report, err, machine.service.pid)
	}
	if !strings.Contains(strings.Join(report.Said, "\n"), "Failed to reach the marketplace") {
		t.Errorf("said %q, want why", report.Said)
	}
}

func TestUpgradeRefusesAWordThatIsNoVersionAndChangesNothing(t *testing.T) {
	machine := anUpgradeOn(t)

	_, err := machine.upgrade.Run("newest")

	if err == nil || !strings.Contains(err.Error(), "newest is no version") {
		t.Fatalf("Run(newest) = %v, want it refused", err)
	}
	if len(machine.plugins.updates) != 0 || len(machine.releases.fetched) != 0 {
		t.Errorf("updated %v and fetched %v, want nothing", machine.plugins.updates, machine.releases.fetched)
	}
}

// withCodexOnOffer offers Codex beside Claude Code, its plugin on 0.39.0.
func withCodexOnOffer(machine *anUpgrade) {
	machine.upgrade.Harnesses = []string{"claude-code", "codex"}
	machine.plugins.versions["codex"] = "0.39.0"
}

func TestUpgradeUpdatesCodexsPluginFromItsReleaseTagAndTrustsItsNewHooks(t *testing.T) {
	machine := anUpgradeOn(t)
	withCodexOnOffer(machine)

	report, err := machine.upgrade.Run(running)

	if err != nil || !report.IsPluginUpdated || !slices.Contains(machine.plugins.updates, "codex v0.40.0") {
		t.Fatalf("Run(Codex on offer) = %+v, %v, updates %v, want Codex's plugin updated from v0.40.0", report, err, machine.plugins.updates)
	}
	want := []string{
		"Updated the aeolus-fleet plugin for Codex from 0.39.0 to 0.40.0. Running Codex sessions keep the version they started with.",
		"Codex trusts the aeolus-fleet plugin's 1 new or changed hooks.",
	}
	if !slices.Equal(report.Said[len(report.Said)-2:], want) {
		t.Errorf("said %q, want it to end %q", report.Said, want)
	}
	if !slices.Equal(machine.codex.hooksFrom, []string{machine.upgrade.Paths.Worktrees}) {
		t.Errorf("trusted hooks from %q, want the worktree root", machine.codex.hooksFrom)
	}
}

func TestUpgradeSaysCodexDoesNotTrustThePluginsHooksAndThePluginIsNotUpdated(t *testing.T) {
	machine := anUpgradeOn(t)
	withCodexOnOffer(machine)
	machine.codex.err = errors.New("codex app-server ended before it answered (exit 1)")

	report, err := machine.upgrade.Run(running)

	if err != nil || report.IsPluginUpdated {
		t.Fatalf("Run(hooks not trusted) = %+v, %v, want the plugin not updated", report, err)
	}
	want := "Codex does not trust the aeolus-fleet plugin's hooks yet: codex app-server ended before it answered (exit 1). Each Codex launch trusts them first, and starts no session while they cannot be; fix what it says, then run aeolus-trierarch upgrade again."
	if !slices.Contains(report.Said, want) {
		t.Errorf("said %q, want %q", report.Said, want)
	}
}

func TestUpgradeTrustsNoHooksOfACodexPluginItCouldNotUpdate(t *testing.T) {
	machine := anUpgradeOn(t)
	withCodexOnOffer(machine)
	machine.upgrade.Harnesses = []string{"codex"}
	machine.plugins.failing = errors.New("codex plugin marketplace upgrade aeolus-fleet failed: could not reach github.com")

	report, err := machine.upgrade.Run(running)

	if err != nil || report.IsPluginUpdated || len(machine.codex.hooksFrom) != 0 {
		t.Fatalf("Run(Codex's plugin failing) = %+v, %v, hooks from %q, want it not updated and no hooks trusted", report, err, machine.codex.hooksFrom)
	}
	want := "The aeolus-fleet plugin for Codex was not updated: codex plugin marketplace upgrade aeolus-fleet failed: could not reach github.com. It stays on 0.39.0; fix what it says, then run aeolus-trierarch upgrade again."
	if !slices.Contains(report.Said, want) {
		t.Errorf("said %q, want %q", report.Said, want)
	}
}

func TestUpgradeSaysNewCodexSessionsKeepStartingOnANewerPluginVersion(t *testing.T) {
	machine := anUpgradeOn(t)
	withCodexOnOffer(machine)
	machine.plugins.kept = map[string]string{"codex": "0.41.0"}

	report, err := machine.upgrade.Run(running)

	if err != nil || !report.IsPluginUpdated {
		t.Fatalf("Run(a Codex downgrade) = %+v, %v, want the plugin updated", report, err)
	}
	want := "New Codex sessions keep starting on the aeolus-fleet plugin 0.41.0, not on 0.40.0: Codex starts on the newest version it has, and 0.41.0 stays for the Codex sessions running on it."
	if !slices.Contains(report.Said, want) {
		t.Errorf("said %q, want %q", report.Said, want)
	}
}

func TestUpgradeAsThePluginStepOfAnUpgradeWritesItsServiceFileAndRestartsNothing(t *testing.T) {
	machine := anUpgradeOn(t)
	machine.upgrade.IsPluginStep = true

	if _, err := machine.upgrade.Run(running); err != nil {
		t.Fatal(err)
	}

	if machine.service.rewrites != 1 || len(machine.service.restarts) != 1 {
		t.Errorf("rewrites %d, restarts %v, want the file written once and no restart", machine.service.rewrites, machine.service.restarts[1:])
	}
}

func TestUpgradeOnItsVersionRestartsAServiceThatRunsAnotherVersion(t *testing.T) {
	machine := anUpgradeOn(t)
	if err := os.WriteFile(machine.upgrade.Paths.Running, []byte(`{"pid":100,"version":"0.36.1"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	report, err := machine.upgrade.Run(running)

	if err != nil || machine.service.rewrites != 1 || !slices.Equal(machine.service.restarts, []string{running, running}) {
		t.Fatalf("Run(the service on 0.36.1) = %v, rewrites %d, restarts %v, want the file written and the service restarted on %s", err, machine.service.rewrites, machine.service.restarts, running)
	}
	if !slices.Contains(report.Said, "The service ran 0.36.1, so it restarted on 0.40.0.") {
		t.Errorf("said %q, want the restart said", report.Said)
	}
}

func TestUpgradeInstallsTheReleasesBinaryInPlaceOfItsOwnFileAndRestartsTheServiceOnIt(t *testing.T) {
	machine := anUpgradeOn(t)

	report, err := machine.upgrade.Run(released)

	if err != nil || !report.IsUpgraded || report.From != running || report.To != released || !report.IsPluginUpdated {
		t.Fatalf("Run(%s) = %+v, %v, want upgraded from %s", released, report, err, running)
	}
	if got := machine.program(t); got != string(binaryOf(released)) {
		t.Errorf("the program is %q, want the release's binary", got)
	}
	if info, err := os.Stat(machine.upgrade.Program); err != nil || info.Mode().Perm() != 0o755 {
		t.Errorf("the program's mode is %v, %v, want 0755", info.Mode(), err)
	}
	if !slices.Equal(machine.service.restarts, []string{running, released}) {
		t.Errorf("restarts %v, want one on %s", machine.service.restarts, released)
	}
	// The installed version runs its own plugin step, which writes its service file too.
	if !slices.Contains(machine.ran, released+" upgrade "+released+" --json") {
		t.Errorf("ran %q, want the plugin step of %s", machine.ran, released)
	}
	if left, _ := filepath.Glob(filepath.Join(filepath.Dir(machine.upgrade.Program), "*")); len(left) != 1 {
		t.Errorf("its folder holds %v, want the program alone", left)
	}
}

func TestUpgradeWithNoVersionTakesTheLatestReleaseButNeverAnOlderOne(t *testing.T) {
	machine := anUpgradeOn(t)

	if report, err := machine.upgrade.Run(""); err != nil || report.To != released {
		t.Fatalf("Run() = %+v, %v, want the latest, %s", report, err, released)
	}

	older := anUpgradeOn(t)
	older.releases.latest = "0.39.2"
	report, err := older.upgrade.Run("")
	if err != nil || report.IsUpgraded || len(older.releases.fetched) != 0 {
		t.Fatalf("Run() with 0.39.2 the latest = %+v, %v, want it to stay on %s", report, err, running)
	}
	if !slices.Contains(report.Said, "The trierarch runs 0.40.0 and the latest release is 0.39.2, an older version: upgrade never moves to an older one, so it stays on 0.40.0.") {
		t.Errorf("said %q", report.Said)
	}
}

// leavesTheOldBinary fails the test unless the trierarch's file is still the old one, alone in its folder, and the service runs it.
func leavesTheOldBinary(t *testing.T, machine *anUpgrade) {
	t.Helper()
	if got := machine.program(t); got != string(binaryOf(running)) {
		t.Errorf("the program is %q, want the old binary", got)
	}
	if left, _ := filepath.Glob(filepath.Join(filepath.Dir(machine.upgrade.Program), "*")); len(left) != 1 {
		t.Errorf("its folder holds %v, want the program alone", left)
	}
	if running, isRead := readRunning(machine.upgrade.Paths.Running); !isRead || running.Version != "0.40.0" || running.PID != machine.service.pid {
		t.Errorf("running.json says %+v, want the service on 0.40.0", running)
	}
}

func TestUpgradeLeavesTheOldBinaryWhenTheReleaseIsNotTaken(t *testing.T) {
	for name, refusal := range map[string]error{
		"a bad checksum":    errors.New("the binary is not the one SHA256SUMS names"),
		"a bad attestation": errors.New("the attestation does not hold: no attestation of sha256:00"),
	} {
		t.Run(name, func(t *testing.T) {
			machine := anUpgradeOn(t)
			machine.releases.refusal = refusal

			_, err := machine.upgrade.Run(released)

			if err == nil || !strings.Contains(err.Error(), refusal.Error()) || !strings.Contains(err.Error(), "The trierarch keeps running 0.40.0") {
				t.Fatalf("Run(%s) = %v, want it refused, saying why", name, err)
			}
			leavesTheOldBinary(t, machine)
			if len(machine.service.restarts) != 1 || len(machine.plugins.updates) != 0 {
				t.Errorf("restarts %v, plugin updates %v, want none", machine.service.restarts[1:], machine.plugins.updates)
			}
		})
	}
}

func TestUpgradeLeavesTheOldBinaryWhenTheNewOneDoesNotRun(t *testing.T) {
	machine := anUpgradeOn(t)
	machine.upgrade.Releases = releasesOf(noVersion)

	_, err := machine.upgrade.Run(released)

	if err == nil || !strings.Contains(err.Error(), "does not run") {
		t.Fatalf("Run(a binary that does not run) = %v, want it refused", err)
	}
	leavesTheOldBinary(t, machine)
}

func TestUpgradeLeavesTheOldBinaryWhenTheNewOneDoesNotAcceptTheConfiguration(t *testing.T) {
	machine := anUpgradeOn(t)
	run := machine.upgrade.Trierarch
	machine.upgrade.Trierarch = func(file string, isPluginStep bool, words ...string) (string, int) {
		if words[0] == "config" {
			return `{"error":"the configuration at config.json does not fit: json: unknown field \"model\""}`, 1
		}
		return run(file, isPluginStep, words...)
	}

	_, err := machine.upgrade.Run(released)

	if err == nil || !strings.Contains(err.Error(), "The trierarch 0.41.0 does not accept the configuration") || !strings.Contains(err.Error(), `unknown field "model"`) {
		t.Fatalf("Run(a configuration 0.41.0 refuses) = %v, want it refused, saying why", err)
	}
	leavesTheOldBinary(t, machine)
	if len(machine.plugins.updates) != 0 || len(machine.service.restarts) != 1 {
		t.Errorf("plugin updates %v, restarts %v, want none", machine.plugins.updates, machine.service.restarts[1:])
	}
}

func TestUpgradePutsTheOldBinaryBackWhenTheNewOneDoesNotStart(t *testing.T) {
	machine := anUpgradeOn(t)
	machine.upgrade.Releases = releasesOf(noStart)

	_, err := machine.upgrade.Run(released)

	if err == nil || !strings.Contains(err.Error(), "did not start") || !strings.Contains(err.Error(), "runs 0.40.0 again") {
		t.Fatalf("Run(a binary that starts no trierarch) = %v, want it refused, the old one back", err)
	}
	leavesTheOldBinary(t, machine)
	if !slices.Equal(machine.service.restarts, []string{running, noStart, running}) {
		t.Errorf("restarts %v, want the new one tried, then the old one again", machine.service.restarts)
	}
}

// releasesOf answer every version with a binary that says the given words in place of a version.
type releasesOf string

func (r releasesOf) Latest() (string, error) { return released, nil }

func (r releasesOf) Fetch(string) ([]byte, error) { return binaryOf(string(r)), nil }

// aServiceThatTakesTheProgram is the service as aServiceOf runs it, but the new version leaves a folder at the program, where no file can be put back.
type aServiceThatTakesTheProgram struct{ *aServiceOf }

func (s aServiceThatTakesTheProgram) Restart() error {
	if err := s.aServiceOf.Restart(); err != nil {
		return err
	}
	if s.restarts[len(s.restarts)-1] != noStart {
		return nil
	}
	if err := os.Remove(s.program); err != nil {
		return err
	}
	return os.MkdirAll(filepath.Join(s.program, "taken"), 0o755)
}

func TestUpgradeKeepsTheOldBinaryWhenItCannotBePutBack(t *testing.T) {
	machine := anUpgradeOn(t)
	machine.upgrade.Releases = releasesOf(noStart)
	machine.upgrade.Service = aServiceThatTakesTheProgram{machine.service}

	_, err := machine.upgrade.Run(released)

	kept := filepath.Join(filepath.Dir(machine.upgrade.Program), ".aeolus-trierarch-"+running)
	if err == nil || !strings.Contains(err.Error(), "could not be put back") || !strings.Contains(err.Error(), kept) {
		t.Fatalf("Run(a put-back that fails) = %v, want it refused, naming where the old binary is kept", err)
	}
	if text, err := os.ReadFile(kept); err != nil || string(text) != string(binaryOf(running)) {
		t.Errorf("%s holds %q (%v), want the old binary kept", kept, text, err)
	}
}

func TestUpgradeReplacesAnOldBinaryAnInterruptedUpgradeLeftBesideTheProgram(t *testing.T) {
	machine := anUpgradeOn(t)
	leftover := filepath.Join(filepath.Dir(machine.upgrade.Program), ".aeolus-trierarch-"+running)
	if err := os.WriteFile(leftover, []byte("left by an upgrade that was killed"), 0o755); err != nil {
		t.Fatal(err)
	}

	report, err := machine.upgrade.Run(released)

	if err != nil || !report.IsUpgraded {
		t.Fatalf("Run(%s) = %+v, %v, want upgraded past the leftover", released, report, err)
	}
	if got := machine.program(t); got != string(binaryOf(released)) {
		t.Errorf("the program is %q, want the release's binary", got)
	}
	if left, _ := filepath.Glob(filepath.Join(filepath.Dir(machine.upgrade.Program), "*")); len(left) != 1 {
		t.Errorf("its folder holds %v, want the program alone", left)
	}
}

func TestUpgradeRunFromTheKeptFileLeavesItInPlace(t *testing.T) {
	machine := anUpgradeOn(t)
	kept := filepath.Join(filepath.Dir(machine.upgrade.Program), ".aeolus-trierarch-"+running)
	if err := os.Rename(machine.upgrade.Program, kept); err != nil {
		t.Fatal(err)
	}
	machine.upgrade.Program = kept

	_, err := machine.upgrade.Run(released)

	if err == nil {
		t.Fatalf("Run(from the kept file) = nil, want it refused: the old file cannot be kept aside from itself")
	}
	if text, err := os.ReadFile(kept); err != nil || string(text) != string(binaryOf(running)) {
		t.Errorf("%s holds %q (%v), want the file it runs from left in place", kept, text, err)
	}
}

func TestUpgradeOnItsVersionTakesRemoteControlOutOfTheConfigurationAndSaysSo(t *testing.T) {
	machine := anUpgradeOn(t)
	configured := config.Initial()
	configured.Harnesses["claude-code"] = config.Harness{Flags: []string{"--remote-control", "--verbose"}, Options: map[string]config.Option{}}
	configured.Harnesses["codex"] = config.Harness{Flags: []string{"--remote-control=mine"}, Options: map[string]config.Option{}}
	if err := config.Write(machine.upgrade.Paths.Config, configured); err != nil {
		t.Fatal(err)
	}

	report, err := machine.upgrade.Run(running)

	if err != nil {
		t.Fatal(err)
	}
	loaded, _ := config.Load(machine.upgrade.Paths.Config)
	if !slices.Equal(loaded.Harnesses["claude-code"].Flags, []string{"--verbose"}) || len(loaded.Harnesses["codex"].Flags) != 0 {
		t.Errorf("flags = %+v, want no Remote Control", loaded.Harnesses)
	}
	want := "Took --remote-control out of the flags of claude-code, codex in the configuration: a session the trierarch runs has no terminal, so no Remote Control."
	if len(report.Said) < 2 || report.Said[0] != "The trierarch is already on 0.40.0." || report.Said[1] != want {
		t.Errorf("said %q, want the version, then %q", report.Said, want)
	}
}
