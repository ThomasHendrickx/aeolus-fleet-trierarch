package cli

import (
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
)

func (i Init) closingReport(report *Report, configuration config.Configuration, detected detection.Detected, pid int, serviceErr error) {
	add := func(part, name, status, detail, fix string) {
		report.Checks = append(report.Checks, Check{part, name, status, detail, fix})
	}
	program := i.Program
	if program == "" {
		program, _ = os.Executable()
	}
	installed := program
	if i.InstallVerification == "attested" {
		installed += ", checksum and attestation checked"
	}
	if i.InstallVerification == "checksum" {
		installed += ", checksum checked; attestation not checked"
	}
	status, fix := "ok", ""
	if i.InstallVerification == "checksum" {
		status, fix = "warning", "install gh and verify the attestation with gh attestation verify "+program
	}
	add("installed", "Installed", status, installed, fix)
	status, fix = "warning", "add "+filepath.Dir(program)+" to PATH, then open a new terminal"
	for _, folder := range filepath.SplitList(i.Path) {
		if folder == filepath.Dir(program) {
			status, fix = "ok", ""
			break
		}
	}
	var loginFiles []string
	if status == "warning" && i.InstallVerification != "" {
		for _, file := range []string{".zprofile", ".bash_profile", ".profile"} {
			contents, err := os.ReadFile(filepath.Join(i.HomeDirectory, file))
			if err == nil && strings.Contains(string(contents), "# >>> aeolus-trierarch >>>") && (strings.Contains(string(contents), filepath.Dir(program)) || strings.Contains(string(contents), "$HOME/"+strings.TrimPrefix(filepath.Dir(program), i.HomeDirectory+"/"))) {
				loginFiles = append(loginFiles, "~/"+file)
			}
		}
		if len(loginFiles) > 0 {
			status, fix = "ok", ""
		}
	}
	detail := filepath.Dir(program) + " is on PATH"
	if status == "warning" {
		detail = filepath.Dir(program) + " is not on PATH"
	} else if len(loginFiles) > 0 {
		detail = "added to " + strings.Join(loginFiles, " and ") + " (this terminal: open a new one)"
	}
	add("onPath", "On PATH", status, detail, fix)
	if serviceErr == nil {
		add("fleet", "Fleet", "ok", report.ShipID+" registered, lease valid, first report accepted", "")
	} else {
		add("fleet", "Fleet", "warning", report.ShipID+" registered; lease and first report not confirmed", "fix the service, then run the same line again")
	}
	for _, state := range i.harnessStates() {
		harness, ok := configuration.Harnesses[state.name]
		if !ok {
			continue
		}
		version := detected[state.name].Version
		if version == "" {
			version = "version unavailable"
		}
		mode := "asks before each command"
		if slices.Contains(harness.Flags, state.unattendedFlag) || state.name == "copilot" {
			mode = "runs without permission questions"
		}
		signed := "signed in"
		status, fix := "ok", ""
		if state.name == "copilot" {
			signed, status, fix = "sign-in cannot be checked", "warning", "run copilot login if not signed in"
		}
		if state.name == codex {
			for _, line := range report.Said {
				if strings.HasPrefix(line, "Codex is not set up:") {
					status, fix = "warning", "run aeolus-trierarch init again"
					signed += ", " + line
				}
			}
		}
		add("harness", state.label, status, fmt.Sprintf("%s, %s, aeolus-fleet plugin %s, %s", version, signed, i.Plugins.Version(state.name), mode), fix)
	}
	var repositories []string
	for _, name := range slices.Sorted(maps.Keys(configuration.Repositories)) {
		repositories = append(repositories, fmt.Sprintf("%s (%s)", name, configuration.Repositories[name].Path))
	}
	status, fix = "ok", ""
	if len(repositories) == 0 {
		repositories = append(repositories, "none")
		status, fix = "warning", "add one with aeolus-trierarch add"
	}
	add("repositories", "Repositories", status, strings.Join(repositories, ", "), fix)
	status, detail, fix = "ok", fmt.Sprintf("running for 10 s, pid %d, starts again at every login", pid), ""
	if serviceErr != nil {
		status, detail, fix = "failed", serviceErr.Error(), "fix the service error, then run the same line again"
	}
	add("service", "Service", status, detail, fix)
	add("caps", "Caps", "ok", fmt.Sprintf("%d ships, %d running", configuration.Caps.Ships, configuration.Caps.Running), "")
	report.Said = []string{fmt.Sprintf("aeolus-trierarch %s: %s joined %s", Version, report.ShipID, report.FleetURL), ""}
	for _, c := range report.Checks {
		mark := "✓"
		if c.Status == "warning" {
			mark = "!"
		}
		if c.Status == "failed" {
			mark = "✗"
		}
		if c.Part == "caps" {
			mark = " "
		}
		line := fmt.Sprintf("  %s %-13s %s", mark, c.Name, c.Detail)
		if c.Fix != "" {
			line += "; " + c.Fix
		}
		report.Said = append(report.Said, line)
	}
	if serviceErr != nil {
		report.Said = append(report.Said, "", "Not ready: fix the line marked ✗, then run the same line again.")
	} else {
		report.Said = append(report.Said, "", "Ready. Check it any time with: aeolus-trierarch status")
	}
}
