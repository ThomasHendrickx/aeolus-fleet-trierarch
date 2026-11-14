package service

import (
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// Label is the launchd agent's label on macOS.
const Label = "dev.aeolus-fleet.trierarch"

// stopChecks is how often stop and install look whether launchd has the agent gone, a Sleep apart.
const stopChecks = 30

var errNotInstalled = errors.New("the service is not installed: run aeolus-trierarch init")

// Launchd is the service on macOS: a launchd agent in the user's GUI domain,
// through `launchctl`. launchd writes the trierarch's stdout and stderr to
// trierarch.log in Logs; the trierarch caps it (package logfile).
type Launchd struct {
	HomeDirectory string
	Logs          string
	// Program is the trierarch's own file: the agent runs it with `run`.
	Program     string
	Environment map[string]string
	UID         int
	Exec        Exec
	// Sleep waits between checks that a stopped agent is gone, a second; a test passes one that does not wait.
	Sleep func()
}

// File is the agent's file.
func (l Launchd) File() string {
	return filepath.Join(l.HomeDirectory, "Library", "LaunchAgents", Label+".plist")
}

func (l Launchd) domain() string {
	return "gui/" + strconv.Itoa(l.UID)
}

func (l Launchd) target() string {
	return l.domain() + "/" + Label
}

var escapeXML = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

func (l Launchd) plist() string {
	var variables []string
	for _, name := range slices.Sorted(maps.Keys(l.Environment)) {
		variables = append(variables, "    <key>"+escapeXML.Replace(name)+"</key>\n    <string>"+escapeXML.Replace(l.Environment[name])+"</string>")
	}
	log := escapeXML.Replace(filepath.Join(l.Logs, "trierarch.log"))
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>` + Label + `</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + escapeXML.Replace(l.Program) + `</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
` + strings.Join(variables, "\n") + `
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>` + log + `</string>
  <key>StandardErrorPath</key>
  <string>` + log + `</string>
</dict>
</plist>
`
}

// Write writes the agent and loads nothing: install --no-load.
func (l Launchd) Write() error {
	if err := os.MkdirAll(l.Logs, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(l.File()), 0o755); err != nil {
		return err
	}
	return os.WriteFile(l.File(), []byte(l.plist()), 0o644)
}

func (l Launchd) isLoaded() bool {
	_, err := l.Exec("launchctl", "print", l.target())
	return err == nil
}

// bootstrap loads the agent: launchd makes it a new job, whose runs count from one again.
func (l Launchd) bootstrap() error {
	if _, err := l.Exec("launchctl", "bootstrap", l.domain(), l.File()); err != nil {
		return err
	}
	return l.recordStart(1)
}

// startedRunsFile keeps launchd's runs as they were when the trierarch itself last started the agent (restart, upgrade, init): launchd counts that run as it counts a crash's.
func (l Launchd) startedRunsFile() string {
	return filepath.Join(l.Logs, "started-runs")
}

// recordStart keeps the runs the trierarch started the agent at, right when it does, so every later run counts as a restart.
func (l Launchd) recordStart(runs int) error {
	if err := os.MkdirAll(l.Logs, 0o755); err != nil {
		return fmt.Errorf("record the runs the trierarch started at: %w", err)
	}
	if err := os.WriteFile(l.startedRunsFile(), []byte(strconv.Itoa(runs)), 0o644); err != nil {
		return fmt.Errorf("record the runs the trierarch started at: %w", err)
	}
	return nil
}

// restartsOf is how often the agent ran again since the trierarch last started it. A job launchd loaded again on its own, at login, has fewer runs than were kept: it counts from its first run.
func (l Launchd) restartsOf(runs int) (int, error) {
	started := 1
	kept, err := os.ReadFile(l.startedRunsFile())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return 0, fmt.Errorf("read the runs the trierarch started at: %w", err)
	}
	if value, err := strconv.Atoi(strings.TrimSpace(string(kept))); err == nil && value >= 1 && value <= runs {
		started = value
	}
	return max(0, runs-started), nil
}

func runsOf(printed string) (int, bool) {
	match := launchdRunsPattern.FindStringSubmatch(printed)
	if match == nil {
		return 0, false
	}
	runs, err := strconv.Atoi(match[1])
	return runs, err == nil
}

// bootout unloads the agent, not kills it: KeepAlive would start a killed one again. It loads again at the next login.
// bootout returns before the process has exited: unloaded means launchd has the agent gone.
func (l Launchd) bootout() error {
	_, _ = l.Exec("launchctl", "bootout", l.target())
	for check := 0; l.isLoaded(); check++ {
		if check >= stopChecks {
			return fmt.Errorf("the trierarch still runs %d s after it was stopped: see aeolus-trierarch status", stopChecks)
		}
		l.Sleep()
	}
	return nil
}

func (l Launchd) isInstalled() bool {
	_, err := os.Stat(l.File())
	return err == nil
}

// Install writes the agent, then loads it, unloading an earlier copy first: bootstrap refuses a loaded agent.
func (l Launchd) Install() error {
	if err := l.Write(); err != nil {
		return err
	}
	if err := l.bootout(); err != nil {
		return err
	}
	return l.bootstrap()
}

// Rewrite writes the agent over an installed one, leaving the running trierarch and its sessions alone: launchd reads the file when it loads the agent again, as the trierarch's own stop and start do.
func (l Launchd) Rewrite() error {
	return l.Write()
}

// Start loads an unloaded agent and kicks a loaded one.
func (l Launchd) Start() error {
	if !l.isInstalled() {
		return errNotInstalled
	}
	if !l.isLoaded() {
		return l.bootstrap()
	}
	if _, err := l.Exec("launchctl", "kickstart", l.target()); err != nil {
		return err
	}
	runs := 1
	if printed, err := l.Exec("launchctl", "print", l.target()); err == nil {
		if counted, ok := runsOf(printed); ok {
			runs = max(1, counted)
		}
	}
	return l.recordStart(runs)
}

// Stop unloads the agent, so KeepAlive does not start it again: its sessions run on under their holds.
func (l Launchd) Stop() error {
	return l.bootout()
}

// Restart unloads the agent and loads its file again, so the agent runs what the file names now: kickstart -k restarts the definition launchd already has loaded, not a rewritten file.
func (l Launchd) Restart() error {
	if !l.isInstalled() {
		return errNotInstalled
	}
	if err := l.bootout(); err != nil {
		return err
	}
	return l.bootstrap()
}

// Uninstall unloads the agent and removes its file.
func (l Launchd) Uninstall() error {
	_, _ = l.Exec("launchctl", "bootout", l.target())
	if err := os.Remove(l.File()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

var launchdPIDPattern = regexp.MustCompile(`(?m)^\s*pid = (\d+)$`)
var launchdRunsPattern = regexp.MustCompile(`(?m)^\s*runs = (\d+)$`)

func (l Launchd) Status() (Status, error) {
	file := l.File()
	if !l.isInstalled() {
		return Status{File: file}, nil
	}
	printed, err := l.Exec("launchctl", "print", l.target())
	if err != nil {
		return Status{File: file, IsInstalled: true}, nil
	}
	status := Status{File: file, IsInstalled: true}
	if runs, ok := runsOf(printed); ok {
		if status.Restarts, err = l.restartsOf(runs); err != nil {
			return Status{}, err
		}
	}
	if match := launchdPIDPattern.FindStringSubmatch(printed); match != nil {
		status.PID, _ = strconv.Atoi(match[1])
		status.IsRunning = status.PID > 0
	} else if status.Restarts > 0 {
		status.IsRestarting = true
	}
	return status, nil
}
