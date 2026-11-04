package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/service"
)

// PluginStepVariable is set when upgrade runs the version it installed as its plugin step: that run writes its service file and restarts nothing.
const PluginStepVariable = "AEOLUS_TRIERARCH_PLUGIN_STEP"

// Releases is where upgrade takes another version from: the GitHub Release, its binary for this system and chip taken only once its checksum and attestation hold.
type Releases interface {
	Latest() (string, error)
	Fetch(version string) ([]byte, error)
}

// Plugins is the aeolus-fleet plugin of each harness, as upgrade updates it.
type Plugins interface {
	// Update installs the plugin of the release tag through the harness's own commands.
	Update(harness string, tag string) error
	// Version is the plugin's version as the harness has it, empty when it has none.
	Version(harness string) string
}

// UpgradeService is the service as upgrade drives it.
type UpgradeService interface {
	Rewrite() error
	Restart() error
	Status() (service.Status, error)
}

// Upgrade is `aeolus-trierarch upgrade [version]`, as today's trierarch's
// (docs/trierarch.md, "A machine joins"), the version taken from the GitHub
// Release, never npm. Another version's binary for this system and chip, once
// its checksum and its attestation hold, is written beside the trierarch's own
// file, in the user's own folder, and must say its version and accept the
// configuration before it replaces the file. The installed version then runs
// its own plugin step, which writes its service file, and the service restarts
// on it. When the new process does not say its version within 30 seconds the
// old file goes back and the service restarts on it. Sessions are not touched:
// the new process takes their holds over. On the version it runs already it
// installs nothing, updates the aeolus-fleet plugin from that version's
// release tag, and restarts a service that runs another version.
type Upgrade struct {
	Paths paths.Paths
	// Version is the version this runs.
	Version string
	// Program is the trierarch's own file, which an upgrade replaces.
	Program string
	// Harnesses are the harnesses the configuration offers.
	Harnesses []string
	Releases  Releases
	Service   UpgradeService
	Plugins   Plugins
	// Trierarch runs a trierarch file with the words, as the plugin step of an upgrade when isPluginStep: what it says on stdout and its exit status.
	Trierarch func(program string, isPluginStep bool, words ...string) (string, int)
	Sleep     func()
	// IsPluginStep is set when this runs as the plugin step of another version's upgrade.
	IsPluginStep bool
}

// UpgradeReport is what upgrade did, in the shape today's trierarch answers.
type UpgradeReport struct {
	From            string   `json:"from"`
	To              string   `json:"to"`
	IsUpgraded      bool     `json:"isUpgraded"`
	IsPluginUpdated bool     `json:"isPluginUpdated"`
	Said            []string `json:"said"`
}

var releaseVersion = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

// byVersion orders versions such as 0.9.0 and 0.10.0 by their numbers.
func byVersion(left string, right string) int {
	a, b := strings.Split(left, "."), strings.Split(right, ".")
	for index := range 3 {
		var x, y int
		if index < len(a) {
			x, _ = strconv.Atoi(a[index])
		}
		if index < len(b) {
			y, _ = strconv.Atoi(b[index])
		}
		if x != y {
			return x - y
		}
	}
	return 0
}

func alreadyOn(version string) string {
	return fmt.Sprintf("The trierarch is already on %s.", version)
}

// Run upgrades to the version, the latest release when it is empty.
func (u Upgrade) Run(version string) (UpgradeReport, error) {
	from := u.Version
	if version != "" && !releaseVersion.MatchString(version) {
		return UpgradeReport{}, fmt.Errorf("%s is no version: give one such as 0.17.2", version)
	}
	target := version
	if target == "" {
		latest, err := u.Releases.Latest()
		if err != nil {
			return UpgradeReport{}, refused(err, "%v\nThe trierarch keeps running %s.", err, from)
		}
		// Only the latest is refused when older: a version the user names is their choice, as a downgrade.
		if byVersion(latest, from) < 0 {
			return UpgradeReport{From: from, To: from, IsPluginUpdated: true, Said: []string{fmt.Sprintf("The trierarch runs %s and the latest release is %s, an older version: upgrade never moves to an older one, so it stays on %s.", from, latest, from)}}, nil
		}
		target = latest
	}
	if target == from {
		return u.onItsVersion()
	}
	return u.install(target)
}

// onItsVersion writes the configuration's schema of this version and updates the plugin from its release tag; then writes the service file as the plugin step of an upgrade, or restarts a service that runs another version.
func (u Upgrade) onItsVersion() (UpgradeReport, error) {
	from := u.Version
	if err := config.WriteSchema(u.Paths.ConfigSchema); err != nil {
		return UpgradeReport{}, err
	}
	isPluginUpdated, pluginSaid := u.updatePlugin()
	report := UpgradeReport{From: from, To: from, IsPluginUpdated: isPluginUpdated, Said: append([]string{alreadyOn(from)}, pluginSaid...)}
	status, err := u.Service.Status()
	if err != nil || !status.IsInstalled {
		return report, err
	}
	if u.IsPluginStep {
		// The version an upgrade installs writes its own service file, so a change to it arrives with the version that makes it.
		return report, u.Service.Rewrite()
	}
	running, isRead := readRunning(u.Paths.Running)
	if !status.IsRunning || !isRead || running.PID != status.PID || running.Version == from {
		return report, nil
	}
	if err := u.Service.Rewrite(); err != nil {
		return report, err
	}
	if err := u.Service.Restart(); err != nil {
		return report, err
	}
	report.Said = append(report.Said, fmt.Sprintf("The service ran %s, so it restarted on %s.", running.Version, from))
	if !u.hasSaid(from) {
		report.Said = append(report.Said, notSaidYet)
		return report, nil
	}
	report.Said = append(report.Said, fmt.Sprintf("The service runs %s now. Its sessions kept running: the new process takes them over.", from))
	return report, nil
}

// updatePlugin updates the aeolus-fleet plugin of each harness on offer from this version's release tag, each on its own: one that fails leaves the others to update.
func (u Upgrade) updatePlugin() (bool, []string) {
	isUpdated := true
	var said []string
	tag := "v" + u.Version
	for _, harness := range u.Harnesses {
		name := harnessNames[harness]
		if harness == codex {
			isUpdated = false
			said = append(said, "The aeolus-fleet plugin for Codex is not updated by the Go trierarch yet: run codex plugin marketplace upgrade aeolus-fleet, then trust its hooks once with aeolus-trierarch init.")
			continue
		}
		if name == "" {
			continue
		}
		before := orNone(u.Plugins.Version(harness))
		if err := u.Plugins.Update(harness, tag); err != nil {
			isUpdated = false
			said = append(said, fmt.Sprintf("The aeolus-fleet plugin for %s was not updated: %v. It stays on %s; fix what it says, then run aeolus-trierarch upgrade again.", name, err, before))
			continue
		}
		after := orNone(u.Plugins.Version(harness))
		if after == before {
			said = append(said, fmt.Sprintf("The aeolus-fleet plugin for %s is on %s already.", name, after))
		} else {
			said = append(said, fmt.Sprintf("Updated the aeolus-fleet plugin for %s from %s to %s.", name, before, after))
		}
	}
	return isUpdated, said
}

func orNone(version string) string {
	if version == "" {
		return "no version"
	}
	return version
}

// install takes the release's binary of the version in place of the trierarch's own file, once it runs and accepts the configuration, and restarts the service on it; the old file goes back when it does not start.
func (u Upgrade) install(to string) (UpgradeReport, error) {
	from := u.Version
	keeps := fmt.Sprintf("The trierarch keeps running %s.", from)
	binary, err := u.Releases.Fetch(to)
	if err != nil {
		return UpgradeReport{}, refused(err, "Upgrade takes no binary of %s: %v\n%s", to, err, keeps)
	}
	folder := filepath.Dir(u.Program)
	staged := filepath.Join(folder, ".aeolus-trierarch-"+to)
	if err := os.WriteFile(staged, binary, 0o755); err != nil {
		return UpgradeReport{}, refused(err, "The trierarch %s could not be written beside %s: %v\n%s", to, u.Program, err, keeps)
	}
	// What upgrade wrote goes on any refusal: only the trierarch's own file stays.
	defer os.Remove(staged)
	if err := os.Chmod(staged, 0o755); err != nil {
		return UpgradeReport{}, err
	}
	if said, err := u.runs(staged, to); err != nil {
		return UpgradeReport{}, refused(err, "The trierarch %s does not run here: %s\n%s", to, said, keeps)
	}
	status, err := u.Service.Status()
	if err != nil {
		return UpgradeReport{}, err
	}
	// The service restarts on the installed version only when it accepts the configuration: one that does not would crash-loop, and the fleet lose the trierarch with its sessions.
	if status.IsInstalled {
		if said, code := u.Trierarch(staged, false, u.withConfig("config", "check", "--json")...); code != 0 {
			return UpgradeReport{}, refused(nil, "The trierarch %s does not accept the configuration: %s\nIt stays on %s, running; the plugin and the service are untouched. Fix the configuration, then run aeolus-trierarch upgrade again.", to, reasonOf(said), from)
		}
	}
	previous := filepath.Join(folder, ".aeolus-trierarch-"+from)
	if err := os.Link(u.Program, previous); err != nil {
		return UpgradeReport{}, refused(err, "The trierarch %s could not be kept aside: %v\n%s", from, err, keeps)
	}
	// The old file is removed once the new one is confirmed or the old one is back in place, never when it could not be put back: then it is the only copy.
	isKept := false
	defer func() {
		if !isKept {
			os.Remove(previous)
		}
	}()
	if err := os.Rename(staged, u.Program); err != nil {
		return UpgradeReport{}, refused(err, "The trierarch %s could not be put in place of %s: %v\n%s", to, u.Program, err, keeps)
	}
	// This process runs the code of the version it replaces: the installed version runs its own plugin step.
	stepSaid, stepCode := u.Trierarch(u.Program, true, u.withConfig("upgrade", to, "--json")...)
	isPluginUpdated, pluginSaid := pluginStepOf(stepSaid, stepCode, to)
	report := UpgradeReport{From: from, To: to, IsUpgraded: true, IsPluginUpdated: isPluginUpdated, Said: append([]string{fmt.Sprintf("Upgraded the trierarch from %s to %s.", from, to)}, pluginSaid...)}
	if !status.IsInstalled {
		report.Said = append(report.Said, "The service is not installed: run aeolus-trierarch init to run it.")
		return report, nil
	}
	if err := u.Service.Restart(); err == nil && u.hasSaid(to) {
		report.Said = append(report.Said, fmt.Sprintf("The service runs %s now. Its sessions kept running: the new process takes them over.", to))
		return report, nil
	}
	err = u.putBack(previous, to)
	isKept = errors.Is(err, errNotPutBack)
	return UpgradeReport{}, err
}

// errNotPutBack is the reason of a refusal whose old file could not be put back, which stays kept beside the program.
var errNotPutBack = errors.New("the old trierarch could not be put back")

// putBack puts the old file back after the installed version did not start, and restarts the service on it.
func (u Upgrade) putBack(previous string, to string) error {
	from := u.Version
	failed := fmt.Sprintf("The trierarch %s did not start: it did not say its version within 30 seconds (aeolus-trierarch logs says why).", to)
	if err := os.Rename(previous, u.Program); err != nil {
		return refused(errors.Join(errNotPutBack, err), "%s\nThe trierarch %s could not be put back in place of %s: %v. It is kept at %s: run aeolus-trierarch upgrade %s from it.", failed, from, u.Program, err, previous, from)
	}
	if err := errors.Join(u.Service.Rewrite(), u.Service.Restart()); err != nil {
		return refused(err, "%s\nThe trierarch %s is back in place, but the service did not restart on it: %v", failed, from, err)
	}
	if !u.hasSaid(from) {
		return refused(nil, "%s\nThe trierarch %s is back in place; the service restarted on it, which has not said its version yet either.", failed, from)
	}
	return refused(nil, "%s\nThe trierarch %s is back in place, and the service runs %s again; the aeolus-fleet plugin stays on %s's: run aeolus-trierarch upgrade %s to put it back too.", failed, from, from, to, from)
}

// refusal is what upgrade says when it refuses, in whole sentences as today's trierarch says it, keeping the reason for errors.Is.
type refusal struct {
	said   string
	reason error
}

func (r refusal) Error() string { return r.said }

func (r refusal) Unwrap() error { return r.reason }

func refused(reason error, format string, args ...any) error {
	return refusal{said: fmt.Sprintf(format, args...), reason: reason}
}

// runs holds when the file says the version it should run.
func (u Upgrade) runs(file string, version string) (string, error) {
	said, code := u.Trierarch(file, false, "--version", "--json")
	var answer struct {
		Version string `json:"version"`
	}
	if code != 0 || json.Unmarshal([]byte(said), &answer) != nil {
		return strings.TrimSpace(said), errors.New("no version")
	}
	if answer.Version != version {
		return fmt.Sprintf("it says it runs %s", answer.Version), errors.New("another version")
	}
	return "", nil
}

func (u Upgrade) withConfig(words ...string) []string {
	if u.Paths.Config == filepath.Join(u.Paths.Home, "config.json") {
		return words
	}
	return append(words, "--config", u.Paths.Config)
}

// hasSaid holds once the service's process said the version in running.json, 30 seconds at most.
func (u Upgrade) hasSaid(version string) bool {
	for check := 0; ; check++ {
		status, err := u.Service.Status()
		running, isRead := readRunning(u.Paths.Running)
		if err == nil && status.IsRunning && isRead && running.PID == status.PID && running.Version == version {
			return true
		}
		if check >= waitChecks {
			return false
		}
		u.Sleep()
	}
}

// reasonOf is what a trierarch said, its error alone when it answered one as JSON.
func reasonOf(said string) string {
	var refusal struct {
		Error string `json:"error"`
	}
	if json.Unmarshal([]byte(said), &refusal) == nil && refusal.Error != "" {
		return refusal.Error
	}
	return strings.TrimSpace(said)
}

// pluginStepOf is the plugin step as the installed version ran it, from what its upgrade at its own version answered.
func pluginStepOf(said string, code int, version string) (bool, []string) {
	var report UpgradeReport
	if err := json.Unmarshal([]byte(said), &report); err != nil || report.Said == nil {
		return false, []string{fmt.Sprintf("The aeolus-fleet plugin was not updated: the trierarch %s said %s (exit %d). Fix what it says, then run aeolus-trierarch upgrade again.", version, strings.TrimSpace(said), code)}
	}
	return report.IsPluginUpdated, slices.DeleteFunc(report.Said, func(line string) bool { return line == alreadyOn(version) })
}
