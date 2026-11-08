// Package cli is the Go trierarch's command line, `aeolus-trierarch`: init,
// status, list, add, login, logs, start, stop, restart, run, uninstall, upgrade, config check, detect, hold and proxy so far, as docs/trierarch.md says them. Each
// command answers what it says and its exit status; a refusal is said on
// stdout, as JSON under --json.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/container"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/keys"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/modelproxy"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/receiving"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/secrets"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/servicelog"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/style"
)

// Version is the version this trierarch runs, set by the release as it builds the binary.
var Version = "0.0.0"

// ServiceManager is the service as the commands use it.
type ServiceManager interface {
	Service
	Write() error
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
	Environ       []string
	HomeDirectory string
	Platform      string
	PID           int
	// ManagedSettings is the folder Claude Code reads its managed settings from.
	ManagedSettings       string
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
	// ContainerHost is the machine as the container runtime's check reads it, with the model token file given (decision 0039).
	ContainerHost func(modelToken string) container.Host
	// NewPass is one pass of the run loop, with the crew file and configuration run read; the pass is told whether the fleet's key is cut off, which the trierarch's own report says.
	NewPass   func(at paths.Paths, kept crew.File, configuration config.Configuration) (func(isKeyCutOff bool) error, error)
	PassEvery time.Duration
	// OwnShip is the trierarch's own ship at the fleet, which run receives for beside the passes; none when nil.
	OwnShip func(kept crew.File) receiving.Ship
	// Trusted keeps the trusted repositories the trierarch plugin's ship sends (aeolus-fleet#384), with the configuration run read; none when nil.
	Trusted func(at paths.Paths, configuration config.Configuration) receiving.Keeper
	// McpServers keeps the MCP servers the trierarch plugin's ship sends; none when nil.
	McpServers func(at paths.Paths) receiving.ServerKeeper
	// Aip keeps the aip setting the trierarch plugin's ship sends; none when nil.
	Aip func(at paths.Paths) receiving.AipKeeper
	// AipCommand is the aip CLI the trierarch keeps for its host sessions (#314); none when nil.
	AipCommand func(at paths.Paths) AipCommand
	// Secrets keeps the secrets the trierarch plugin's ship sends, opened with the sealing key; none when nil.
	Secrets  func(at paths.Paths) receiving.SecretKeeper
	Sessions func(at paths.Paths) Sessions
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
	// Detect detects what the harnesses given offer, as by says, and keeps it in detected.json (#365).
	Detect func(at paths.Paths, harnesses []string, by detection.By) (detection.Detected, error)
	// ServiceLog is the trierarch's log where its service writes it, as logs reads it.
	ServiceLog func(at paths.Paths) servicelog.Log
	// IsTerminal says whether stdout is a terminal, where status and list colour their words.
	IsTerminal bool
	// StartedAt is when the process started, ISO 8601; empty when it cannot be told.
	StartedAt func(pid int) string
	// Print writes a line to stdout at once, as logs --follow does for each line it follows.
	Print func(line string)
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
  install [--no-load]
                 install the service: launchd on macOS, systemd on Linux; --no-load only writes its file
  logs [--lines <n>] [--follow]
                 the last lines of the log (the journal on Linux), and with --follow each new one
  start, stop, restart
                 drive the service; the sessions keep running
  run            what the service runs
  uninstall      remove the service and stop every session
  upgrade [version]
                 take that version, or the latest, from its GitHub Release, checked against its
                 checksum and attestation, and restart the service on it; update the aeolus-fleet plugin
  config check   check the configuration this version runs on
  detect         detect again what each configured harness offers (models, effort) and keep it beside the configuration
  --version, -v  the version this runs

  --json         answer as JSON
  --config <path> the configuration (AEOLUS_TRIERARCH_CONFIG)`

var valueFlags = []string{"--fleet-url", "--ship-id", "--secret", "--plugin-ship-id", "--config", "--default", "--ship", "--lines"}
var switchFlags = []string{"--json", "--yes", "--version", "--api-key", "--remove-key", "--check", "--no-load", "--follow"}

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
	// Colour only where a person reads it: --json and a pipe get the plain words.
	look := style.Plain
	if !isJSON {
		look = style.Of(machine.Environ, machine.IsTerminal)
	}
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
				AipCommand:            machine.aipCommandOf(at),
				Detect: func(harnesses []string, by detection.By) (detection.Detected, error) {
					return machine.Detect(at, harnesses, by)
				},
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
			return status(at, machine, look)
		},
		"run": func() (answer, error) {
			return run(at, machine)
		},
		"list": func() (answer, error) {
			return list(at, look)
		},
		"start": func() (answer, error) {
			return drive(at, machine, "started", machine.Service(at).Start)
		},
		"install": func() (answer, error) {
			return install(at, machine, command.switches["--no-load"])
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
		"logs": func() (answer, error) {
			return logs(at, machine, command)
		},
		"config check": func() (answer, error) {
			return configCheck(at, machine)
		},
		"detect": func() (answer, error) {
			configuration, err := config.Load(at.Config)
			if err != nil {
				return answer{}, err
			}
			// Every configured harness again, though its version is the one detected; a running trierarch reads it at its next start.
			harnesses := slices.Sorted(maps.Keys(configuration.Harnesses))
			detected, err := machine.Detect(at, harnesses, detection.ByHand)
			if err != nil {
				return answer{}, err
			}
			return answer{data: map[string]any{"harnesses": detection.ReportOf(detected)}, text: detection.Describe(harnesses, detected)}, nil
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
	if isJSON && said.data != nil {
		return mustJSON(said.data), said.code
	}
	return said.text, said.code
}

// upgrade is `upgrade [version]`, with the harnesses the configuration offers; none without a configuration yet. A plugin that could not be updated shows in the exit status.
func upgrade(at paths.Paths, machine Machine, command parsed) (answer, error) {
	var harnesses []string
	hookFolder := at.Worktrees
	if configuration, err := config.Load(at.Config); err == nil {
		harnesses = slices.Sorted(maps.Keys(configuration.Harnesses))
		if configuration.WorktreeRoot != "" {
			hookFolder = configuration.WorktreeRoot
		}
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
		Codex:        machine.Codex(),
		HookFolder:   hookFolder,
		Trierarch:    machine.Trierarch,
		Sleep:        machine.Sleep,
		IsPluginStep: variable(machine.Environ, PluginStepVariable) == "1",
		AipCommand:   machine.aipCommandOf(at),
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
	// A session in a container is held to its ship only on a runtime config check takes (decision 0039): none starts otherwise.
	if err := checkRuntime(at, configuration, machine); err != nil {
		return answer{}, err
	}
	if refusal := machine.CoreVersionRefusal(kept.FleetURL); refusal != "" {
		return answer{}, errors.New(refusal)
	}
	// A machine set up before there was a sealing key gets one at its next start, so no init is needed for it.
	sealingKey, err := secrets.LoadOrMake(at.SealingKey)
	if err != nil {
		return answer{}, err
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
	stopped, done := context.WithCancel(context.Background())
	defer done()
	received := make(chan struct{})
	keptAip := make(chan struct{})
	go func() {
		defer close(keptAip)
		keepAipCommand(stopped, machine.aipCommandOf(at), machine.PassEvery)
	}()
	var isKeyCutOff atomic.Bool
	go func() {
		defer close(received)
		if machine.OwnShip == nil {
			return
		}
		loop := receiving.Loop{Ship: machine.OwnShip(kept), Log: machine.Log, Interval: machine.PassEvery, KeyWaitMax: KeyWaitMax, Pause: pause, PluginShipID: kept.PluginShipID, OnKeyCutOff: isKeyCutOff.Store}
		if machine.Trusted != nil {
			loop.Trusted = machine.Trusted(at, configuration)
		}
		if machine.McpServers != nil {
			loop.McpServers = machine.McpServers(at)
		}
		if machine.Aip != nil {
			loop.Aip = machine.Aip(at)
		}
		if machine.Secrets != nil {
			loop.Secrets, loop.SealingKey = machine.Secrets(at), sealingKey
		}
		loop.Run(stopped)
	}()
	for {
		if err := pass(isKeyCutOff.Load()); err != nil {
			machine.Log("the pass failed: " + err.Error())
		}
		select {
		case <-machine.Stop:
			// The stop ends a receive the fleet still holds at once: a service manager that stops the trierarch sees it gone in a moment.
			done()
			<-received
			<-keptAip
			return answer{data: map[string]bool{"stopped": true}, text: "aeolus-trierarch stopped."}, nil
		case <-time.After(machine.PassEvery):
		}
	}
}

// aipCommandOf is the aip CLI the trierarch keeps on the machine; none when nil.
func (m Machine) aipCommandOf(at paths.Paths) AipCommand {
	if m.AipCommand == nil {
		return nil
	}
	return m.AipCommand(at)
}

// checkRuntime refuses a configuration whose sessions cannot run on the machine, with every reason.
func checkRuntime(at paths.Paths, configuration config.Configuration, machine Machine) error {
	refusals, err := container.Check(configuration, machine.ContainerHost(at.ModelToken), at.ModelToken)
	if err != nil {
		return err
	}
	if len(refusals) > 0 {
		return container.Refusal(at.Config, refusals)
	}
	return nil
}

// KeyWaitMax is the most run waits between receives while the fleet's key is cut off: core's key cache lasts 5 minutes (decision 0068).
const KeyWaitMax = 5 * time.Minute

// pause waits, ending at once when ctx ends.
func pause(ctx context.Context, wait time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(wait):
	}
}
