package service

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// aLaunchctl answers each command line as told, and any other as launchctl does for an agent it has not loaded.
type aLaunchctl struct {
	calls   []string
	answers map[string]string
	// onSleep runs at each wait between checks, as launchd goes on meanwhile.
	onSleep func(waits int)
	waits   int
}

func (l *aLaunchctl) exec(name string, args ...string) (string, error) {
	line := name + " " + strings.Join(args, " ")
	l.calls = append(l.calls, line)
	if output, ok := l.answers[line]; ok {
		return output, nil
	}
	return "", errors.New(name + " " + args[0] + " failed: not loaded")
}

func (l *aLaunchctl) sleep() {
	l.waits++
	if l.onSleep != nil {
		l.onSleep(l.waits)
	}
}

const target = "gui/501/dev.aeolus-fleet.trierarch"

func anAgent(t *testing.T, launchctl *aLaunchctl) Launchd {
	t.Helper()
	if launchctl.answers == nil {
		launchctl.answers = map[string]string{}
	}
	home := t.TempDir()
	return Launchd{
		HomeDirectory: home,
		Logs:          filepath.Join(home, ".aeolus", "trierarch", "logs"),
		Program:       "/Users/me/.local/bin/aeolus-trierarch",
		Environment:   map[string]string{"PATH": "/opt/homebrew/bin:/usr/bin:/bin", "AEOLUS_PLUGIN_ROOT": "/Users/me/aeolus-fleet/plugins/aeolus-fleet"},
		UID:           501,
		Exec:          launchctl.exec,
		Sleep:         launchctl.sleep,
	}
}

func plistOf(agent Launchd) string {
	return filepath.Join(agent.HomeDirectory, "Library", "LaunchAgents", "dev.aeolus-fleet.trierarch.plist")
}

func installed(t *testing.T, launchctl *aLaunchctl) Launchd {
	t.Helper()
	agent := anAgent(t, launchctl)
	launchctl.answers["launchctl bootstrap gui/501 "+plistOf(agent)] = ""
	if err := agent.Install(); err != nil {
		t.Fatal(err)
	}
	launchctl.calls = nil
	return agent
}

func TestInstallWritesTheAgentThatRunsTheBinaryAtLoginAndWheneverItStopsAndLoadsIt(t *testing.T) {
	launchctl := &aLaunchctl{answers: map[string]string{}}
	agent := anAgent(t, launchctl)
	launchctl.answers["launchctl bootstrap gui/501 "+plistOf(agent)] = ""

	if err := agent.Install(); err != nil {
		t.Fatal(err)
	}

	plist, err := os.ReadFile(plistOf(agent))
	if err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(agent.HomeDirectory, ".aeolus", "trierarch", "logs", "trierarch.log")
	for _, part := range []string{
		"<key>Label</key>\n  <string>dev.aeolus-fleet.trierarch</string>",
		"<key>ProgramArguments</key>\n  <array>\n    <string>/Users/me/.local/bin/aeolus-trierarch</string>\n    <string>run</string>\n  </array>",
		"<key>RunAtLoad</key>\n  <true/>",
		"<key>KeepAlive</key>\n  <true/>",
		"<key>StandardOutPath</key>\n  <string>" + log + "</string>",
		"<key>StandardErrorPath</key>\n  <string>" + log + "</string>",
		"<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin:/bin</string>",
		"<key>AEOLUS_PLUGIN_ROOT</key>\n    <string>/Users/me/aeolus-fleet/plugins/aeolus-fleet</string>",
	} {
		if !strings.Contains(string(plist), part) {
			t.Errorf("the agent has no %q:\n%s", part, plist)
		}
	}
	if _, err := os.Stat(agent.Logs); err != nil {
		t.Errorf("the log folder is not there: %v", err)
	}
	want := []string{"launchctl bootout " + target, "launchctl print " + target, "launchctl bootstrap gui/501 " + plistOf(agent)}
	if !slices.Equal(launchctl.calls, want) {
		t.Errorf("ran %q, want %q", launchctl.calls, want)
	}
}

func TestTheAgentEscapesWhatXMLWouldReadAsMarkup(t *testing.T) {
	agent := anAgent(t, &aLaunchctl{})
	agent.Environment = map[string]string{"PATH": "/a&b/<bin>"}

	if err := agent.Rewrite(); err != nil {
		t.Fatal(err)
	}

	plist, _ := os.ReadFile(plistOf(agent))
	if !strings.Contains(string(plist), "<string>/a&amp;b/&lt;bin&gt;</string>") {
		t.Errorf("the agent does not escape PATH:\n%s", plist)
	}
}

func TestInstallOverARunningAgentLoadsItAgainOnlyOnceLaunchdHasTheOldOneGone(t *testing.T) {
	launchctl := &aLaunchctl{answers: map[string]string{"launchctl print " + target: "state = running", "launchctl bootout " + target: ""}}
	agent := anAgent(t, launchctl)
	launchctl.onSleep = func(waits int) {
		if waits == 2 {
			delete(launchctl.answers, "launchctl print "+target)
			launchctl.answers["launchctl bootstrap gui/501 "+plistOf(agent)] = ""
		}
	}

	if err := agent.Install(); err != nil {
		t.Fatal(err)
	}

	if launchctl.waits != 2 {
		t.Errorf("waited %d times, want 2", launchctl.waits)
	}
}

func TestInstallSaysWhyWhenLaunchdRefusesToLoadIt(t *testing.T) {
	agent := anAgent(t, &aLaunchctl{})

	if err := agent.Install(); err == nil || !strings.Contains(err.Error(), "launchctl bootstrap failed: not loaded") {
		t.Errorf("Install() = %v, want launchctl bootstrap failed: not loaded", err)
	}
}

func TestTheAgentIsNotInstalledBeforeInstall(t *testing.T) {
	agent := anAgent(t, &aLaunchctl{})

	status, err := agent.Status()

	if err != nil {
		t.Fatal(err)
	}
	if status != (Status{File: plistOf(agent)}) {
		t.Errorf("Status() = %+v, want not installed at %s", status, plistOf(agent))
	}
}

func TestTheAgentRunsWithThePIDLaunchdSays(t *testing.T) {
	launchctl := &aLaunchctl{}
	agent := installed(t, launchctl)
	launchctl.answers["launchctl print "+target] = target + " = {\n\tstate = running\n\tpid = 4242\n}"

	status, err := agent.Status()

	if err != nil {
		t.Fatal(err)
	}
	if status != (Status{File: plistOf(agent), IsInstalled: true, IsRunning: true, PID: 4242}) {
		t.Errorf("Status() = %+v, want running as 4242", status)
	}
}

func TestTheAgentIsInstalledButNotRunningWhenLaunchdHasItUnloaded(t *testing.T) {
	launchctl := &aLaunchctl{}
	agent := installed(t, launchctl)

	status, err := agent.Status()

	if err != nil {
		t.Fatal(err)
	}
	if status != (Status{File: plistOf(agent), IsInstalled: true}) {
		t.Errorf("Status() = %+v, want installed, not running", status)
	}
}

func TestStopUnloadsTheAgentSoKeepAliveDoesNotStartItAgain(t *testing.T) {
	launchctl := &aLaunchctl{}
	agent := anAgent(t, launchctl)

	if err := agent.Stop(); err != nil {
		t.Fatal(err)
	}

	want := []string{"launchctl bootout " + target, "launchctl print " + target}
	if !slices.Equal(launchctl.calls, want) {
		t.Errorf("ran %q, want %q", launchctl.calls, want)
	}
}

func TestStopSaysStoppedOnlyOnceLaunchdHasTheAgentGone(t *testing.T) {
	launchctl := &aLaunchctl{answers: map[string]string{"launchctl print " + target: "state = running"}}
	launchctl.onSleep = func(waits int) {
		if waits == 3 {
			delete(launchctl.answers, "launchctl print "+target)
		}
	}
	agent := anAgent(t, launchctl)

	if err := agent.Stop(); err != nil {
		t.Fatal(err)
	}

	printed := 0
	for _, call := range launchctl.calls {
		if call == "launchctl print "+target {
			printed++
		}
	}
	if launchctl.waits != 3 || printed != 4 {
		t.Errorf("waited %d times and asked launchd %d times, want 3 and 4", launchctl.waits, printed)
	}
}

func TestStopSaysWhyWhenTheAgentIsStillThereLongAfterItWasStopped(t *testing.T) {
	agent := anAgent(t, &aLaunchctl{answers: map[string]string{"launchctl print " + target: "state = running"}})

	if err := agent.Stop(); err == nil || !strings.Contains(err.Error(), "the trierarch still runs 30 s after it was stopped") {
		t.Errorf("Stop() = %v, want the trierarch still runs 30 s after it was stopped", err)
	}
}

func TestStartLoadsAnUnloadedAgentAndKicksALoadedOne(t *testing.T) {
	launchctl := &aLaunchctl{}
	agent := installed(t, launchctl)

	if err := agent.Start(); err != nil {
		t.Fatal(err)
	}
	launchctl.answers["launchctl print "+target] = "state = waiting"
	launchctl.answers["launchctl kickstart "+target] = ""
	if err := agent.Start(); err != nil {
		t.Fatal(err)
	}

	want := []string{"launchctl print " + target, "launchctl bootstrap gui/501 " + plistOf(agent), "launchctl print " + target, "launchctl kickstart " + target}
	if !slices.Equal(launchctl.calls, want) {
		t.Errorf("ran %q, want %q", launchctl.calls, want)
	}
}

func TestRestartAfterARewriteLoadsTheNewFileAgain(t *testing.T) {
	launchctl := &aLaunchctl{}
	agent := installed(t, launchctl)
	launchctl.answers["launchctl print "+target] = "state = running"
	launchctl.answers["launchctl bootout "+target] = ""
	launchctl.answers["launchctl bootstrap gui/501 "+plistOf(agent)] = ""
	launchctl.onSleep = func(int) { delete(launchctl.answers, "launchctl print "+target) }
	agent.Program = "/Users/me/.local/bin/aeolus-trierarch-new"

	if err := agent.Rewrite(); err != nil {
		t.Fatal(err)
	}
	if err := agent.Restart(); err != nil {
		t.Fatal(err)
	}

	want := []string{"launchctl bootout " + target, "launchctl print " + target, "launchctl print " + target, "launchctl bootstrap gui/501 " + plistOf(agent)}
	if !slices.Equal(launchctl.calls, want) {
		t.Errorf("ran %q, want %q", launchctl.calls, want)
	}
	plist, _ := os.ReadFile(plistOf(agent))
	if !strings.Contains(string(plist), "<string>/Users/me/.local/bin/aeolus-trierarch-new</string>") {
		t.Errorf("the file bootstrap loads does not name the new program:\n%s", plist)
	}
}

func TestRestartLoadsAnUnloadedAgent(t *testing.T) {
	launchctl := &aLaunchctl{}
	agent := installed(t, launchctl)
	launchctl.answers["launchctl bootstrap gui/501 "+plistOf(agent)] = ""

	if err := agent.Restart(); err != nil {
		t.Fatal(err)
	}

	last := launchctl.calls[len(launchctl.calls)-1]
	if last != "launchctl bootstrap gui/501 "+plistOf(agent) {
		t.Errorf("ran %q, want it to end with bootstrap", launchctl.calls)
	}
}

func TestStartAndRestartRefuseBeforeInstall(t *testing.T) {
	agent := anAgent(t, &aLaunchctl{})

	for name, drive := range map[string]func() error{"Start": agent.Start, "Restart": agent.Restart} {
		if err := drive(); err == nil || !strings.Contains(err.Error(), "the service is not installed: run aeolus-trierarch init") {
			t.Errorf("%s() = %v, want the service is not installed", name, err)
		}
	}
}

func TestUninstallUnloadsTheAgentAndRemovesItsFile(t *testing.T) {
	launchctl := &aLaunchctl{}
	agent := installed(t, launchctl)

	if err := agent.Uninstall(); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(plistOf(agent)); !os.IsNotExist(err) {
		t.Errorf("the agent is still there: %v", err)
	}
	if want := []string{"launchctl bootout " + target}; !slices.Equal(launchctl.calls, want) {
		t.Errorf("ran %q, want %q", launchctl.calls, want)
	}
}

func TestRewriteWritesTheAgentWithoutLoadingItAgainSoTheRunningTrierarchIsLeftAlone(t *testing.T) {
	launchctl := &aLaunchctl{}
	agent := anAgent(t, launchctl)

	if err := agent.Rewrite(); err != nil {
		t.Fatal(err)
	}

	if plist, err := os.ReadFile(plistOf(agent)); err != nil || !strings.Contains(string(plist), "<key>KeepAlive</key>") {
		t.Errorf("the agent is not written: %v", err)
	}
	if len(launchctl.calls) != 0 {
		t.Errorf("ran %q, want nothing", launchctl.calls)
	}
}

func TestWriteWritesTheAgentAndLoadsNothing(t *testing.T) {
	launchctl := &aLaunchctl{}
	agent := anAgent(t, launchctl)

	if err := agent.Write(); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(agent.File()); err != nil {
		t.Errorf("the agent is not written: %v", err)
	}
	if len(launchctl.calls) != 0 {
		t.Errorf("ran %q, want nothing", launchctl.calls)
	}
}

func TestTheAgentReportsRestartsAcrossItsProcesses(t *testing.T) {
	launchctl := &aLaunchctl{}
	agent := installed(t, launchctl)
	launchctl.answers["launchctl print "+target] = target + " = {\n\tstate = waiting\n\truns = 7\n\tlast exit code = 1\n}"
	status, err := agent.Status()
	if err != nil {
		t.Fatal(err)
	}
	if !status.IsRestarting || status.Restarts != 6 {
		t.Errorf("Status() = %+v, want six restarts and restarting", status)
	}
}

func TestARestartTheAgentWasToldToMakeIsNoRestartLoop(t *testing.T) {
	for name, drive := range map[string]func(Launchd) error{
		"Start":   func(agent Launchd) error { return agent.Start() },
		"Restart": func(agent Launchd) error { return agent.Restart() },
		"Install": func(agent Launchd) error { return agent.Install() },
	} {
		t.Run(name, func(t *testing.T) {
			launchctl := &aLaunchctl{}
			agent := installed(t, launchctl)
			launchctl.answers["launchctl bootstrap gui/501 "+plistOf(agent)] = ""
			launchctl.answers["launchctl kickstart "+target] = ""
			launchctl.answers["launchctl print "+target] = target + " = {\n\tstate = running\n\tpid = 41\n\truns = 7\n}"

			if err := drive(agent); err != nil {
				t.Fatal(err)
			}
			status, err := agent.Status()
			if err != nil {
				t.Fatal(err)
			}
			if status.Restarts != 0 || status.IsRestarting {
				t.Errorf("Status() = %+v, want no restarts after a deliberate one", status)
			}

			launchctl.answers["launchctl print "+target] = target + " = {\n\tstate = waiting\n\truns = 9\n}"
			status, err = agent.Status()
			if err != nil {
				t.Fatal(err)
			}
			if status.Restarts != 2 || !status.IsRestarting {
				t.Errorf("Status() = %+v, want the two exits since counted", status)
			}
		})
	}
}
