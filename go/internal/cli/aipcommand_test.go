package cli

import (
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/aipcommand"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
)

// anAipCommand is the trierarch's aip folder on a stand-in machine: Ensure answers the state it is given, and the folder holds aip while the state names a version and it is not broken.
type anAipCommand struct {
	mu       sync.Mutex
	state    aipcommand.State
	isBroken bool
	ensured  int
}

func (a *anAipCommand) Ensure() aipcommand.State {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.ensured++
	a.isBroken = false
	return a.state
}

func (a *anAipCommand) Bin() (string, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return "/aip-command/bin", a.state.Version != "" && !a.isBroken
}

func (a *anAipCommand) State() aipcommand.State {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.state
}

func (a *anAipCommand) timesEnsured() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.ensured
}

var (
	installed     = aipcommand.State{Version: "0.7.0"}
	notDownloaded = aipcommand.State{Missing: "the install of aip 0.7.0 failed: uv 0.13.7 could not be downloaded: connection refused"}
)

func TestInitInstallsTheAipCommandAndSaysItsVersion(t *testing.T) {
	machine := newMachine(t)
	command := &anAipCommand{state: installed}
	machine.init.AipCommand = command

	report, err := machine.init.Run(setupLine())

	if err != nil || command.timesEnsured() != 1 || !slices.Contains(report.Said, "Host sessions run aip 0.7.0, which the trierarch keeps in "+machine.init.Paths.AipCommand+".") {
		t.Errorf("Run() = %q, %v after %d installs, want aip 0.7.0 installed once and said", report.Said, err, command.timesEnsured())
	}
}

func TestInitThatCannotInstallAipSaysWhyHostSessionsGetNoAip(t *testing.T) {
	machine := newMachine(t)
	machine.init.AipCommand = &anAipCommand{state: notDownloaded}

	report, err := machine.init.Run(setupLine())

	if err != nil || !slices.Contains(report.Said, "Host sessions get no aip: the install of aip 0.7.0 failed: uv 0.13.7 could not be downloaded: connection refused.") {
		t.Errorf("Run() = %q, %v, want why there is no aip", report.Said, err)
	}
}

func TestUpgradeInstallsTheAipCommandOfItsPinAndSaysItsVersion(t *testing.T) {
	machine := anUpgradeOn(t)
	command := &anAipCommand{state: installed}
	machine.upgrade.AipCommand = command

	report, err := machine.upgrade.Run(running)

	if err != nil || command.timesEnsured() != 1 || !slices.Contains(report.Said, "Host sessions run aip 0.7.0, which the trierarch keeps in "+machine.upgrade.Paths.AipCommand+".") {
		t.Errorf("Run() = %q, %v after %d installs, want aip 0.7.0 installed once and said", report.Said, err, command.timesEnsured())
	}
}

func TestUpgradeAsThePluginStepOfAnUpgradeInstallsTheAipCommandOfItsPin(t *testing.T) {
	machine := anUpgradeOn(t)
	machine.upgrade.IsPluginStep = true
	command := &anAipCommand{state: installed}
	machine.upgrade.AipCommand = command

	if _, err := machine.upgrade.Run(running); err != nil || command.timesEnsured() != 1 {
		t.Errorf("Run() = %v after %d installs, want the new version's aip installed once", err, command.timesEnsured())
	}
}

func TestStatusSaysTheAipHostSessionsRun(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	machine.AipCommand = func(paths.Paths) AipCommand { return &anAipCommand{state: installed} }

	output, _ := Main([]string{"status"}, machine)

	if !slices.Contains(strings.Split(output, "\n"), "aip: 0.7.0 for host sessions") {
		t.Errorf("status said:\n%s\nwant aip 0.7.0 for host sessions", output)
	}
}

func TestStatusSaysWhyHostSessionsGetNoAip(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	machine.AipCommand = func(paths.Paths) AipCommand { return &anAipCommand{state: notDownloaded} }

	output, _ := Main([]string{"status"}, machine)

	if !slices.Contains(strings.Split(output, "\n"), "aip: none for host sessions: the install of aip 0.7.0 failed: uv 0.13.7 could not be downloaded: connection refused") {
		t.Errorf("status said:\n%s\nwant why there is no aip", output)
	}
}

func TestStatusAnswersTheAipAsJSON(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	machine.AipCommand = func(paths.Paths) AipCommand { return &anAipCommand{state: notDownloaded} }

	output, _ := Main([]string{"status", "--json"}, machine)

	if got := decoded(t, output)["aip"]; !reflect.DeepEqual(got, map[string]any{"missing": notDownloaded.Missing}) {
		t.Errorf("status --json aip = %v, want why there is none", got)
	}
}

func TestRunInstallsTheAipCommandAsItStartsAndAgainWhenItsFolderBreaks(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	stop := make(chan struct{})
	machine.Stop = stop
	command := &anAipCommand{state: installed}
	machine.AipCommand = func(paths.Paths) AipCommand { return command }
	go func() {
		defer close(stop)
		for until := time.Now().Add(5 * time.Second); time.Now().Before(until); time.Sleep(time.Millisecond) {
			if command.timesEnsured() == 1 {
				command.mu.Lock()
				command.isBroken = true
				command.mu.Unlock()
			}
			if command.timesEnsured() >= 2 {
				return
			}
		}
	}()

	if output, code := Main([]string{"run"}, machine); code != 0 {
		t.Fatalf("run answered %q, %d", output, code)
	}

	if command.timesEnsured() < 2 {
		t.Errorf("installed %d times, want once at the start and again once the folder broke", command.timesEnsured())
	}
}

func TestRunInstallsNothingMoreWhileTheFolderHoldsThePinnedAip(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	stop := make(chan struct{})
	machine.Stop = stop
	command := &anAipCommand{state: installed}
	machine.AipCommand = func(paths.Paths) AipCommand { return command }
	go func() {
		time.Sleep(200 * time.Millisecond)
		close(stop)
	}()

	Main([]string{"run"}, machine)

	if command.timesEnsured() != 1 {
		t.Errorf("installed %d times over 200 passes, want only the check at the start", command.timesEnsured())
	}
}

func TestRunGoesOnAfterAFailedInstallAndDoesNotTryAgainEveryPass(t *testing.T) {
	machine, _, _ := aMain(t)
	Main(setupWords(), machine)
	stop := make(chan struct{})
	machine.Stop = stop
	command := &anAipCommand{state: aipcommand.State{Missing: "the install of aip 0.7.0 failed: pip ended with exit status 1"}}
	machine.AipCommand = func(paths.Paths) AipCommand { return command }
	passes := 0
	machine.NewPass = func(paths.Paths, crew.File, config.Configuration) (func(isKeyCutOff bool) error, error) {
		return func(bool) error {
			if passes++; passes == 200 {
				close(stop)
			}
			return nil
		}, nil
	}

	if output, code := Main([]string{"run"}, machine); code != 0 || passes != 200 {
		t.Fatalf("run answered %q, %d after %d passes", output, code, passes)
	}

	if command.timesEnsured() != 1 {
		t.Errorf("installed %d times over 200 passes, want the one at the start", command.timesEnsured())
	}
}
