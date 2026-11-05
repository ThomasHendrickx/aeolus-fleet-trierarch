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

func (l Launchd) bootstrap() error {
	_, err := l.Exec("launchctl", "bootstrap", l.domain(), l.File())
	return err
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
	_, err := l.Exec("launchctl", "kickstart", l.target())
	return err
}

// Stop unloads the agent, so KeepAlive does not start it again: its sessions run on under their holds.
func (l Launchd) Stop() error {
	return l.bootout()
}

// Restart kills a loaded agent's process for launchd to start it again, and loads an unloaded one.
func (l Launchd) Restart() error {
	if !l.isInstalled() {
		return errNotInstalled
	}
	if !l.isLoaded() {
		return l.bootstrap()
	}
	_, err := l.Exec("launchctl", "kickstart", "-k", l.target())
	return err
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

func (l Launchd) Status() (Status, error) {
	file := l.File()
	if !l.isInstalled() {
		return Status{File: file}, nil
	}
	printed, err := l.Exec("launchctl", "print", l.target())
	if err != nil {
		return Status{File: file, IsInstalled: true}, nil
	}
	match := launchdPIDPattern.FindStringSubmatch(printed)
	if match == nil {
		return Status{File: file, IsInstalled: true}, nil
	}
	pid, _ := strconv.Atoi(match[1])
	return Status{File: file, IsInstalled: true, IsRunning: true, PID: pid}, nil
}
