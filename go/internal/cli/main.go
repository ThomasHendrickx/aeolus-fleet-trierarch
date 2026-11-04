// Package cli is the Go trierarch's command line, `aeolus-trierarch`: init,
// status, list, add, login, start, stop, restart, run, uninstall, upgrade, config check, hold and proxy so far, as docs/trierarch.md says them. Each
// command answers what it says and its exit status; a refusal is said on
// stdout, as JSON under --json.
package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/keys"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/modelproxy"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

// Version is the version this trierarch runs, set by the release as it builds the binary.
var Version = "0.0.0"

// ServiceManager is the service as the commands use it.
type ServiceManager interface {
	Service
	Start() error
	Stop() error
	Uninstall() error
}

// Sessions are the sessions that run on the machine, as uninstall stops them.
type Sessions interface {
	List() ([]sessions.Observed, error)
	Stop(shipID string) error
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
	ClaudeCode       func(homeDirectory string, configDirectory string) ClaudeCode
	IsCodexInstalled func() bool
	IsCodexSignedIn  func() bool
	// Codex is Codex's setup, through its app server.
	Codex       func() Codex
	Service     func(at paths.Paths) ServiceManager
	Register    func(fleetURL string, shipID string, secret string) (string, error)
	IsLeaseHeld func(fleetURL string, crewToken string) (bool, error)
	Sleep       func()
	// Stop is closed when the process is told to stop (SIGTERM, SIGINT).
	Stop <-chan struct{}
	// CoreVersionRefusal is why the trierarch may not run against the fleet's core, empty when it may.
	CoreVersionRefusal func(fleetURL string) string
	// NewPass is one pass of the run loop, with the crew file and configuration run read.
	NewPass   func(at paths.Paths, kept crew.File, configuration config.Configuration) (func() error, error)
	PassEvery time.Duration
	Sessions  func(at paths.Paths) Sessions
	// Log writes a line to the trierarch's log.
	Log func(line string)
	// ReadKey is the API key the operator types, not shown, or pipes in.
	ReadKey func() (string, error)
	// CheckKey checks a key with its harness's vendor before login keeps it.
	CheckKey func(harness string, key string) keys.Checked
	// CheckNow has the model proxy check the harness's key at once (K10): its state after; false when the proxy does not run.
	CheckNow func(at paths.Paths, harness string) (keys.StateAt, bool)
	// Program is the trierarch's own file, which upgrade replaces.
	Program string
	// Releases is where upgrade takes another version from.
	Releases func() Releases
	// Plugins is the aeolus-fleet plugin of each harness, as upgrade updates it.
	Plugins func() Plugins
	// Trierarch runs a trierarch file with the words, as the plugin step of an upgrade when isPluginStep: its stdout and its exit status.
	Trierarch func(program string, isPluginStep bool, words ...string) (string, int)
}

const usage = `Usage: aeolus-trierarch <command>

  init --fleet-url <url> --ship-id <id> --secret <secret> [--plugin-ship-id <id>] [--yes]
                 set this machine up from the trierarch plugin's setup line
  status         how the trierarch stands on this machine
  list           the ships it crews
  add repository|folder <name> <path>
                 add a place the trierarch may crew ships in, and trust it
  login          each harness's login and whether it holds an API key
  login <harness> --api-key
                 read an API key for claude-code or codex from stdin (not shown as typed), check it
                 with the vendor and keep it on this computer only, then restart the service
  login <harness> --remove-key
                 remove the API key for that harness, then restart the service
  login <harness> --check
                 check an API key out of credit at once, as the model proxy does every 15 minutes
  login <harness> --default api-key|subscription
                 the login that harness's sessions run on, from each one's next start
  login --ship <name> api-key|subscription|default
                 the login that ship runs on, or its harness's default again, from its next start
  start, stop, restart
                 drive the service; the sessions keep running
  run            what the service runs
  uninstall      remove the service and stop every session
  upgrade [version]
                 take that version, or the latest, from its GitHub Release, checked against its
                 checksum and attestation, and restart the service on it; update the aeolus-fleet plugin
  config check   check the configuration this version runs on
  --version, -v  the version this runs

  --json         answer as JSON
  --config <path> the configuration (AEOLUS_TRIERARCH_CONFIG)`

var valueFlags = []string{"--fleet-url", "--ship-id", "--secret", "--plugin-ship-id", "--config", "--default", "--ship"}
var switchFlags = []string{"--json", "--yes", "--version", "--api-key", "--remove-key", "--check"}

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

// answer is what a command says: its data under --json, its text otherwise, and its exit status when it is not 0.
type answer struct {
	data any
	text string
	code int
}

// Main runs one command line of aeolus-trierarch and answers what it says and its exit status.
func Main(args []string, machine Machine) (string, int) {
	// The hold takes its own words: the trierarch starts it, never a person.
	if len(args) > 0 && args[0] == "hold" {
		return "", hold.Main(args[1:], Version, machine.Environ)
	}
	if len(args) > 0 && args[0] == "proxy" {
		return "", modelproxy.Main(args[1:], Version)
	}
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
				IsCodexInstalled:      machine.IsCodexInstalled(),
				IsCodexSignedIn:       machine.IsCodexSignedIn(),
				Codex:                 machine.Codex(),
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
		"list": func() (answer, error) {
			return list(at)
		},
		"start": func() (answer, error) {
			return drive(at, machine, "started", machine.Service(at).Start)
		},
		"restart": func() (answer, error) {
			return drive(at, machine, "restarted", machine.Service(at).Restart)
		},
		"stop": func() (answer, error) {
			if err := machine.Service(at).Stop(); err != nil {
				return answer{}, err
			}
			said := "The trierarch stopped; its sessions keep running, and nothing is handed to them until it runs again."
			return answer{data: map[string]any{"service": "stopped", "said": []string{said}}, text: said}, nil
		},
		"config check": func() (answer, error) {
			configuration, err := config.Load(at.Config)
			if err != nil {
				return answer{}, err
			}
			harnesses := slices.Sorted(maps.Keys(configuration.Harnesses))
			return answer{data: map[string]any{"path": at.Config, "harnesses": harnesses}, text: fmt.Sprintf("The configuration at %s is one this trierarch runs on, offering %s.", at.Config, strings.Join(harnesses, ", "))}, nil
		},
		"uninstall": func() (answer, error) {
			manager := machine.Service(at)
			before, err := manager.Status()
			if err != nil {
				return answer{}, err
			}
			// The service goes first, so nothing starts a session again.
			if err := manager.Uninstall(); err != nil {
				return answer{}, err
			}
			running, err := machine.Sessions(at).List()
			if err != nil {
				return answer{}, err
			}
			for _, session := range running {
				if err := machine.Sessions(at).Stop(session.ShipID); err != nil {
					return answer{}, err
				}
			}
			said := []string{
				fmt.Sprintf("Removed the service (%s): the trierarch no longer runs, and stopped every session it ran.", before.File),
				fmt.Sprintf("Its configuration, crew token, state and logs stay in %s. Its ship, and the ships it crewed, stay crewed in the fleet: release them in the console.", at.Home),
			}
			return answer{data: map[string]any{"service": before.File, "said": said}, text: strings.Join(said, "\n")}, nil
		},
	}
	if len(command.words) <= 2 && len(command.words) >= 1 && command.words[0] == "upgrade" {
		commands[strings.Join(command.words, " ")] = func() (answer, error) {
			return upgrade(at, machine, command)
		}
	}
	if len(command.words) == 4 && command.words[0] == "add" && (command.words[1] == "repository" || command.words[1] == "folder") {
		commands[strings.Join(command.words, " ")] = func() (answer, error) {
			return add(at, machine, command.words[1:])
		}
	}
	if len(command.words) >= 1 && len(command.words) <= 2 && command.words[0] == "login" {
		commands[strings.Join(command.words, " ")] = func() (answer, error) {
			return login(at, machine, command)
		}
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
		return mustJSON(said.data), said.code
	}
	return said.text, said.code
}

// upgrade is `upgrade [version]`, with the harnesses the configuration offers; none without a configuration yet. A plugin that could not be updated shows in the exit status.
func upgrade(at paths.Paths, machine Machine, command parsed) (answer, error) {
	var harnesses []string
	if configuration, err := config.Load(at.Config); err == nil {
		harnesses = slices.Sorted(maps.Keys(configuration.Harnesses))
	}
	version := ""
	if len(command.words) == 2 {
		version = command.words[1]
	}
	report, err := Upgrade{
		Paths:        at,
		Version:      Version,
		Program:      machine.Program,
		Harnesses:    harnesses,
		Releases:     machine.Releases(),
		Service:      machine.Service(at),
		Plugins:      machine.Plugins(),
		Trierarch:    machine.Trierarch,
		Sleep:        machine.Sleep,
		IsPluginStep: variable(machine.Environ, PluginStepVariable) == "1",
	}.Run(version)
	if err != nil {
		return answer{}, err
	}
	code := 0
	if !report.IsPluginUpdated {
		code = 1
	}
	return answer{data: report, text: strings.Join(report.Said, "\n"), code: code}, nil
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

// run is what the service runs: once the fleet's core is one it runs against, it says its pid and version in running.json, then runs a pass every interval until it is stopped. A failed pass is logged and the loop goes on.
func run(at paths.Paths, machine Machine) (answer, error) {
	kept, err := crew.Read(at.CrewToken)
	if err != nil {
		return answer{}, err
	}
	configuration, err := config.Load(at.Config)
	if err != nil {
		return answer{}, err
	}
	if refusal := machine.CoreVersionRefusal(kept.FleetURL); refusal != "" {
		return answer{}, errors.New(refusal)
	}
	pass, err := machine.NewPass(at, kept, configuration)
	if err != nil {
		return answer{}, err
	}
	if err := os.MkdirAll(at.Home, 0o700); err != nil {
		return answer{}, err
	}
	if err := os.WriteFile(at.Running, []byte(mustJSON(Running{PID: machine.PID, Version: Version})+"\n"), 0o644); err != nil {
		return answer{}, err
	}
	machine.Log(fmt.Sprintf("aeolus-trierarch %s runs as pid %d", Version, machine.PID))
	for {
		if err := pass(); err != nil {
			machine.Log("the pass failed: " + err.Error())
		}
		select {
		case <-machine.Stop:
			return answer{data: map[string]bool{"stopped": true}, text: "aeolus-trierarch stopped."}, nil
		case <-time.After(machine.PassEvery):
		}
	}
}
