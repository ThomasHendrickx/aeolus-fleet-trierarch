// Package service is the trierarch as a service of the operating system:
// `aeolus-trierarch run` kept alive, started at login and again whenever it
// stops. On Linux a systemd user unit, through `systemctl --user`; it stops
// its main process only (`KillMode=process`), so the sessions the trierarch
// started outlive a stop.
package service

import (
	"errors"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

const Unit = "aeolus-trierarch.service"

// variables are the ones the trierarch itself reads, carried into the service when set where install ran.
var variables = []string{"AEOLUS_PLUGIN_ROOT", "AEOLUS_PLUGIN_DATA", "AEOLUS_CODEX_PLUGIN_ROOT", "AEOLUS_CODEX_PLUGIN_DATA", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "AEOLUS_TRIERARCH_CONFIG"}

const defaultPath = "/usr/bin:/bin"

// Environment is the service's environment from the one install runs in: PATH, so it finds git and the harnesses, and the trierarch's own variables.
func Environment(environ []string) map[string]string {
	environment := map[string]string{"PATH": defaultPath}
	for _, entry := range environ {
		name, value, _ := strings.Cut(entry, "=")
		if name == "PATH" || slices.Contains(variables, name) {
			environment[name] = value
		}
	}
	return environment
}

// Status is how the service stands: its file, whether it is installed and running, and the running process.
type Status struct {
	File        string `json:"file"`
	IsInstalled bool   `json:"isInstalled"`
	IsRunning   bool   `json:"isRunning"`
	PID         int    `json:"pid,omitempty"`
}

// Exec runs a program and answers its output.
type Exec func(name string, args ...string) (string, error)

// Run runs a program as Exec does, its error saying what it wrote on stderr.
func Run(name string, args ...string) (string, error) {
	command := exec.Command(name, args...)
	var stderr strings.Builder
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		return string(output), fmt.Errorf("%s %s failed: %s", name, strings.Join(args[:min(2, len(args))], " "), strings.TrimSpace(stderr.String()))
	}
	return string(output), nil
}

type Systemd struct {
	HomeDirectory string
	Logs          string
	// Program is the trierarch's own file: the unit runs it with `run`.
	Program     string
	Environment map[string]string
	Exec        Exec
}

// File is the unit's file.
func (s Systemd) File() string {
	return filepath.Join(s.HomeDirectory, ".config", "systemd", "user", Unit)
}

func (s Systemd) systemctl(args ...string) (string, error) {
	return s.Exec("systemctl", append([]string{"--user"}, args...)...)
}

func (s Systemd) unit() string {
	var lines []string
	for _, name := range slices.Sorted(maps.Keys(s.Environment)) {
		lines = append(lines, fmt.Sprintf(`Environment="%s=%s"`, name, s.Environment[name]))
	}
	return `[Unit]
Description=Aeolus trierarch: keeps the ships assigned to it crewed on this machine

[Service]
ExecStart="` + s.Program + `" run
` + strings.Join(lines, "\n") + `
Restart=always
RestartSec=5
# The sessions run under holds the trierarch starts, each in a scope of its own: a stop ends the trierarch only (#479).
KillMode=process

[Install]
WantedBy=default.target
`
}

func (s Systemd) write() error {
	if err := os.MkdirAll(s.Logs, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.File()), 0o755); err != nil {
		return err
	}
	return os.WriteFile(s.File(), []byte(s.unit()), 0o644)
}

// Install writes the unit, then enables and starts it: restart, not start, since an active unit runs the old file until it restarts.
func (s Systemd) Install() error {
	if err := s.write(); err != nil {
		return err
	}
	for _, args := range [][]string{{"daemon-reload"}, {"enable", Unit}, {"restart", Unit}} {
		if _, err := s.systemctl(args...); err != nil {
			return err
		}
	}
	return nil
}

// Rewrite writes the unit over an installed one for its next start, and reloads systemd, leaving the running trierarch and its sessions alone.
func (s Systemd) Rewrite() error {
	if err := s.write(); err != nil {
		return err
	}
	_, err := s.systemctl("daemon-reload")
	return err
}

func (s Systemd) Start() error {
	_, err := s.systemctl("start", Unit)
	return err
}

// Stop stops the trierarch alone: its sessions run on under their holds (KillMode=process).
func (s Systemd) Stop() error {
	_, err := s.systemctl("stop", Unit)
	return err
}

func (s Systemd) Restart() error {
	_, err := s.systemctl("restart", Unit)
	return err
}

// Uninstall stops the service and removes its unit.
func (s Systemd) Uninstall() error {
	_, stopped := s.systemctl("disable", "--now", Unit)
	if err := os.Remove(s.File()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_, reloaded := s.systemctl("daemon-reload")
	return errors.Join(stopped, reloaded)
}

var (
	activePattern = regexp.MustCompile(`(?m)^ActiveState=active$`)
	pidPattern    = regexp.MustCompile(`(?m)^MainPID=(\d+)$`)
)

func (s Systemd) Status() (Status, error) {
	file := s.File()
	if _, err := os.Stat(file); err != nil {
		return Status{File: file}, nil
	}
	shown, err := s.systemctl("show", Unit, "-p", "ActiveState", "-p", "MainPID")
	if err != nil {
		return Status{}, err
	}
	pid := 0
	if match := pidPattern.FindStringSubmatch(shown); match != nil {
		pid, _ = strconv.Atoi(match[1])
	}
	if !activePattern.MatchString(shown) || pid <= 0 {
		return Status{File: file, IsInstalled: true}, nil
	}
	return Status{File: file, IsInstalled: true, IsRunning: true, PID: pid}, nil
}
