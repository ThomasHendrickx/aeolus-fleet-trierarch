package service

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// aSystemctl answers `show` as systemd does for a unit that is active with the pid given, or inactive with none.
type aSystemctl struct {
	calls []string
	pid   string
}

func (s *aSystemctl) exec(name string, args ...string) (string, error) {
	s.calls = append(s.calls, name+" "+strings.Join(args, " "))
	if slices.Contains(args, "show") {
		if s.pid == "" {
			return "ActiveState=inactive\nMainPID=0\n", nil
		}
		return "ActiveState=active\nMainPID=" + s.pid + "\n", nil
	}
	return "", nil
}

func aService(t *testing.T, systemctl *aSystemctl) Systemd {
	t.Helper()
	home := t.TempDir()
	return Systemd{
		HomeDirectory: home,
		Logs:          filepath.Join(home, ".aeolus", "trierarch", "logs"),
		Program:       "/home/me/.local/bin/aeolus-trierarch",
		Environment:   map[string]string{"PATH": "/usr/bin:/bin", "AEOLUS_PLUGIN_ROOT": "/plugin"},
		Exec:          systemctl.exec,
	}
}

func TestInstallWritesTheUnitThatRunsTheTrierarchAndStartsIt(t *testing.T) {
	systemctl := &aSystemctl{}
	service := aService(t, systemctl)

	if err := service.Install(); err != nil {
		t.Fatal(err)
	}

	unit, err := os.ReadFile(filepath.Join(service.HomeDirectory, ".config", "systemd", "user", "aeolus-trierarch.service"))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{`ExecStart="/home/me/.local/bin/aeolus-trierarch" run`, `Environment="AEOLUS_PLUGIN_ROOT=/plugin"`, `Environment="PATH=/usr/bin:/bin"`, "Restart=always", "KillMode=process", "WantedBy=default.target"} {
		if !slices.Contains(strings.Split(string(unit), "\n"), line) {
			t.Errorf("the unit has no line %s:\n%s", line, unit)
		}
	}
	want := []string{"systemctl --user daemon-reload", "systemctl --user enable aeolus-trierarch.service", "systemctl --user restart aeolus-trierarch.service"}
	if !slices.Equal(systemctl.calls, want) {
		t.Errorf("ran %q, want %q", systemctl.calls, want)
	}
}

func TestRewriteWritesTheUnitAgainAndReloadsWithoutARestart(t *testing.T) {
	systemctl := &aSystemctl{}
	service := aService(t, systemctl)

	if err := service.Rewrite(); err != nil {
		t.Fatal(err)
	}

	if !slices.Equal(systemctl.calls, []string{"systemctl --user daemon-reload"}) {
		t.Errorf("ran %q", systemctl.calls)
	}
}

func TestStatusSaysAServiceNotInstalled(t *testing.T) {
	service := aService(t, &aSystemctl{pid: "41"})

	status, err := service.Status()

	if err != nil {
		t.Fatal(err)
	}
	if status.IsInstalled || status.IsRunning || status.PID != 0 {
		t.Errorf("status %+v, want not installed", status)
	}
}

func TestStatusSaysTheRunningProcess(t *testing.T) {
	systemctl := &aSystemctl{}
	service := aService(t, systemctl)
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	systemctl.pid = "41"

	status, err := service.Status()

	if err != nil {
		t.Fatal(err)
	}
	if !status.IsInstalled || !status.IsRunning || status.PID != 41 {
		t.Errorf("status %+v, want running as 41", status)
	}
}

func TestStatusSaysAnInstalledServiceThatDoesNotRun(t *testing.T) {
	systemctl := &aSystemctl{}
	service := aService(t, systemctl)
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}

	status, err := service.Status()

	if err != nil {
		t.Fatal(err)
	}
	if !status.IsInstalled || status.IsRunning {
		t.Errorf("status %+v, want installed, not running", status)
	}
}

func TestUninstallStopsTheServiceAndRemovesItsUnit(t *testing.T) {
	systemctl := &aSystemctl{}
	service := aService(t, systemctl)
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	systemctl.calls = nil

	if err := service.Uninstall(); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(service.File()); !os.IsNotExist(err) {
		t.Errorf("the unit is still there: %v", err)
	}
	want := []string{"systemctl --user disable --now aeolus-trierarch.service", "systemctl --user daemon-reload"}
	if !slices.Equal(systemctl.calls, want) {
		t.Errorf("ran %q, want %q", systemctl.calls, want)
	}
}

func TestTheServiceEnvironmentCarriesPATHAndTheTrierarchsOwnVariablesOnly(t *testing.T) {
	environment := Environment([]string{"PATH=/opt/bin", "AEOLUS_PLUGIN_DATA=/data", "CLAUDE_CONFIG_DIR=/claude", "SECRET=no", "AEOLUS_FOLDER=/elsewhere"})

	want := map[string]string{"PATH": "/opt/bin", "AEOLUS_PLUGIN_DATA": "/data", "CLAUDE_CONFIG_DIR": "/claude"}
	if len(environment) != len(want) {
		t.Fatalf("environment %v, want %v", environment, want)
	}
	for name, value := range want {
		if environment[name] != value {
			t.Errorf("%s is %q, want %q", name, environment[name], value)
		}
	}
}
