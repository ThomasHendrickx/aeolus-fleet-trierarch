// Package cli is the Go trierarch's command line, `aeolus-trierarch`: init,
// status, run and uninstall so far, as docs/trierarch.md says them. Each
// command answers what it says and its exit status; a refusal is said on
// stdout, as JSON under --json.
package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
)

// Version is the version this trierarch runs, set by the release as it builds the binary.
var Version = "0.0.0"

// ServiceManager is the service as the commands use it.
type ServiceManager interface {
	Service
	Uninstall() error
}

// Machine is what the commands reach on the machine they run on.
type Machine struct {
	Environ               []string
	HomeDirectory         string
	Platform              string
	PID                   int
	IsClaudeCodeInstalled func() bool
	IsClaudeCodeSignedIn  func() bool
	IsSsMissing           func() bool
	// ClaudeCode is Claude Code's setup for the home folder and CLAUDE_CONFIG_DIR.
	ClaudeCode  func(homeDirectory string, configDirectory string) ClaudeCode
	Service     func(at paths.Paths) ServiceManager
	Register    func(fleetURL string, shipID string, secret string) (string, error)
	IsLeaseHeld func(fleetURL string, crewToken string) (bool, error)
	Sleep       func()
	// Stop is closed when the process is told to stop (SIGTERM, SIGINT).
	Stop <-chan struct{}
}

const usage = `Usage: aeolus-trierarch <command>

  init --fleet-url <url> --ship-id <id> --secret <secret> [--plugin-ship-id <id>] [--yes]
                 set this machine up from the trierarch plugin's setup line
  status         how the trierarch stands on this machine
  run            what the service runs
  uninstall      remove the service
  --version, -v  the version this runs

  --json         answer as JSON
  --config <path> the configuration (AEOLUS_TRIERARCH_CONFIG)`

var valueFlags = []string{"--fleet-url", "--ship-id", "--secret", "--plugin-ship-id", "--config"}
var switchFlags = []string{"--json", "--yes", "--version"}

type parsed struct {
	words    []string
	values   map[string]string
	switches map[string]bool
}

// parse takes words, `--flag value` and `--flag=value`; nothing for a flag it does not know or a value missing.
func parse(args []string) (parsed, bool) {
	result := parsed{values: map[string]string{}, switches: map[string]bool{}}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if !strings.HasPrefix(arg, "--") {
			result.words = append(result.words, arg)
			continue
		}
		name, value, hasValue := strings.Cut(arg, "=")
		switch {
		case slices.Contains(switchFlags, name) && !hasValue:
			result.switches[name] = true
		case slices.Contains(valueFlags, name) && hasValue:
			result.values[name] = value
		case slices.Contains(valueFlags, name) && index+1 < len(args):
			index++
			result.values[name] = args[index]
		default:
			return parsed{}, false
		}
	}
	return result, true
}

func variable(environ []string, name string) string {
	for _, entry := range environ {
		if key, value, ok := strings.Cut(entry, "="); ok && key == name {
			return value
		}
	}
	return ""
}

// answer is what a command says: its data under --json, its text otherwise.
type answer struct {
	data any
	text string
}

// Main runs one command line of aeolus-trierarch and answers what it says and its exit status.
func Main(args []string, machine Machine) (string, int) {
	command, ok := parse(args)
	if !ok {
		return usage, 2
	}
	isJSON := command.switches["--json"]
	if (command.switches["--version"] && len(command.words) == 0) || slices.Equal(command.words, []string{"-v"}) {
		if isJSON {
			return mustJSON(map[string]string{"version": Version}), 0
		}
		return Version, 0
	}
	configPath := command.values["--config"]
	if configPath == "" {
		configPath = variable(machine.Environ, "AEOLUS_TRIERARCH_CONFIG")
	}
	at := paths.Of(machine.HomeDirectory, configPath)
	commands := map[string]func() (answer, error){
		"init": func() (answer, error) {
			report, err := Init{
				Paths:                 at,
				Platform:              machine.Platform,
				IsSsMissing:           machine.IsSsMissing(),
				IsClaudeCodeInstalled: machine.IsClaudeCodeInstalled(),
				IsClaudeCodeSignedIn:  machine.IsClaudeCodeSignedIn(),
				ClaudeCode:            machine.ClaudeCode(machine.HomeDirectory, variable(machine.Environ, "CLAUDE_CONFIG_DIR")),
				Service:               machine.Service(at),
				Register:              machine.Register,
				IsLeaseHeld:           machine.IsLeaseHeld,
				Sleep:                 machine.Sleep,
			}.Run(Flags{
				FleetURL:     command.values["--fleet-url"],
				ShipID:       command.values["--ship-id"],
				Secret:       command.values["--secret"],
				PluginShipID: command.values["--plugin-ship-id"],
				IsYes:        command.switches["--yes"],
			})
			return answer{data: report, text: strings.Join(report.Said, "\n")}, err
		},
		"status": func() (answer, error) {
			return status(at, machine)
		},
		"run": func() (answer, error) {
			return run(at, machine)
		},
		"uninstall": func() (answer, error) {
			manager := machine.Service(at)
			before, err := manager.Status()
			if err != nil {
				return answer{}, err
			}
			if err := manager.Uninstall(); err != nil {
				return answer{}, err
			}
			said := []string{
				fmt.Sprintf("Removed the service (%s): the trierarch no longer runs.", before.File),
				fmt.Sprintf("Its configuration, crew token, state and logs stay in %s. Its ship, and the ships it crewed, stay crewed in the fleet: release them in the console.", at.Home),
			}
			return answer{data: map[string]any{"service": before.File, "said": said}, text: strings.Join(said, "\n")}, nil
		},
	}
	do, isKnown := commands[strings.Join(command.words, " ")]
	if !isKnown {
		return usage, 2
	}
	said, err := do()
	if err != nil {
		if isJSON {
			return mustJSON(map[string]string{"error": err.Error()}), 1
		}
		return err.Error(), 1
	}
	if isJSON {
		return mustJSON(said.data), 0
	}
	return said.text, 0
}

func mustJSON(value any) string {
	text, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Sprintf(`{"error":%q}`, err.Error())
	}
	return string(text)
}

// status is how the trierarch stands on this machine: the version it runs, the service and the trierarch's own lease.
func status(at paths.Paths, machine Machine) (answer, error) {
	kept, err := crew.Read(at.CrewToken)
	if err != nil {
		return answer{}, err
	}
	service, err := machine.Service(at).Status()
	if err != nil {
		return answer{}, err
	}
	lease := "valid"
	if held, err := machine.IsLeaseHeld(kept.FleetURL, kept.CrewToken); err != nil {
		lease = "unreachable"
	} else if !held {
		lease = "ended"
	}
	report := map[string]any{"version": Version, "service": service, "fleet": map[string]any{"url": kept.FleetURL, "shipId": kept.ShipID, "lease": lease}}
	// Only the service's own process counts: a file left by an earlier process says nothing of it.
	running, isRead := readRunning(at.Running)
	text := []string{"Version: " + Version}
	if service.IsRunning && isRead && running.PID == service.PID {
		report["runningVersion"] = running.Version
	}
	switch {
	case !service.IsInstalled:
		text = append(text, "Service: not installed (aeolus-trierarch init)")
	case !service.IsRunning:
		text = append(text, "Service: installed, not running")
	default:
		text = append(text, fmt.Sprintf("Service: running, pid %d", service.PID))
	}
	text = append(text, fmt.Sprintf("Fleet: %s, the lease of %s is %s", kept.FleetURL, kept.ShipID, lease))
	return answer{data: report, text: strings.Join(text, "\n")}, nil
}

// run is what the service runs: it says its pid and version in running.json, then waits to be stopped. It crews no ship yet.
func run(at paths.Paths, machine Machine) (answer, error) {
	if err := os.MkdirAll(at.Home, 0o700); err != nil {
		return answer{}, err
	}
	if err := os.WriteFile(at.Running, []byte(mustJSON(Running{PID: machine.PID, Version: Version})+"\n"), 0o644); err != nil {
		return answer{}, err
	}
	fmt.Fprintf(os.Stderr, "aeolus-trierarch %s runs as pid %d; it crews no ship yet.\n", Version, machine.PID)
	<-machine.Stop
	return answer{data: map[string]bool{"stopped": true}, text: "aeolus-trierarch stopped."}, nil
}
