package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/url"
	"os"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/fleet"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/secrets"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/service"
)

// Flags are init's flags, as the trierarch plugin's setup line gives them.
type Flags struct {
	FleetURL string
	ShipID   string
	Secret   string
	// PluginShipID is the trierarch plugin's ship: the one ship the trusted repositories are taken from.
	PluginShipID string
	IsYes        bool
	// Harnesses is nil when the wizard must ask, empty when none were picked.
	Harnesses []string
	// Unattended is nil when unanswered; an empty list explicitly keeps permission questions.
	Unattended       []string
	MaxShips         string
	MaxRunning       string
	Repositories     []string
	RepositoriesIn   string
	IsNoRepositories bool
	CloneInto        string
}

// Report is what init did, for the operator and for --json.
type Report struct {
	IsSetUpAlready bool   `json:"isSetUpAlready"`
	FleetURL       string `json:"fleetUrl"`
	ShipID         string `json:"shipId,omitempty"`
	// Configuration is written or kept.
	Configuration string   `json:"configuration"`
	Trusted       []string `json:"trusted"`
	// CodexTrusted are the repositories and folders Codex now trusts, when the configuration offers Codex.
	CodexTrusted []string `json:"codexTrusted"`
	// CodexHooksTrusted are the aeolus-fleet plugin's hooks Codex trusts since this run, by key.
	CodexHooksTrusted []string `json:"codexHooksTrusted"`
	// Service is installed, restarted or unchanged.
	Service string   `json:"service"`
	Said    []string `json:"said"`
}

// ClaudeCode answers Claude Code's one-time questions ahead.
type ClaudeCode interface {
	Trust(folder string) error
	CompleteOnboarding() error
}

// Codex answers Codex's one-time questions ahead, through its app server.
type Codex interface {
	Trust(folders []string) error
	TrustAeolusHooks(folder string) ([]string, error)
}

// Service is the trierarch as a service of the operating system, as init uses it.
type Service interface {
	Install() error
	Rewrite() error
	Restart() error
	Status() (service.Status, error)
}

// Init is `aeolus-trierarch init`, the setup of a machine from the trierarch
// plugin's setup line (docs/trierarch.md, "A machine joins"): it registers the
// trierarch's own ship and keeps its crew token, never the secret; writes the
// configuration with the picked harnesses; makes Claude Code
// and Codex ready to run; and installs the
// service. Run again with the same setup line, it registers nothing and goes
// on with a setup that did not finish, registering its ship again only once it
// was released. Options left out are asked on the controlling terminal.
type Init struct {
	HomeDirectory         string
	Paths                 paths.Paths
	Platform              string
	IsSsMissing           bool
	IsClaudeCodeInstalled bool
	IsClaudeCodeSignedIn  bool
	ClaudeCode            ClaudeCode
	IsCodexInstalled      bool
	IsCodexSignedIn       bool
	IsCopilotInstalled    bool
	IsCursorInstalled     bool
	// OpenTerminal reads the controlling terminal, independently of stdin under curl | sh.
	OpenTerminal func() (io.ReadWriteCloser, error)
	Codex        Codex
	Service      Service
	// Plugins installs the aeolus-fleet plugin of each picked harness, as upgrade does.
	Plugins     Plugins
	Register    func(fleetURL string, shipID string, secret string) (string, error)
	IsLeaseHeld func(fleetURL string, crewToken string) (bool, error)
	// Sleep waits between reads of running.json; a test passes one that does not wait.
	Sleep   func()
	Now     func() time.Time
	LastLog func() string
	// Detect detects what the harnesses given offer, as by says, and keeps it in detected.json (#365).
	Detect func(harnesses []string, by detection.By) (detection.Detected, error)
}

const (
	claudeCode = "claude-code"
	codex      = "codex"
)

// waitChecks is how often init reads running.json, a second apart, for the started process to say its version.
const waitChecks = 30

const notSaidYet = "The new process has not said its version after 30 seconds: aeolus-trierarch status shows the version it runs once it does."

// checkMachine refuses, before anything is registered, a machine the trierarch cannot run on or crew anything from.
func (i Init) checkMachine() error {
	if i.Platform != "darwin" && i.Platform != "linux" {
		return fmt.Errorf("aeolus-trierarch knows launchd (macOS) and systemd (Linux), not %s: run aeolus-trierarch run under your own supervisor", i.Platform)
	}
	if i.IsSsMissing {
		return errors.New("`ss` is not installed, and the trierarch needs it to tell which process calls a ship socket: without it no session starts. Install iproute2 (Debian and Ubuntu: sudo apt-get install iproute2), then run the setup line again")
	}
	return nil
}

func asFleetURL(text string) (string, error) {
	parsed, err := url.Parse(text)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", fmt.Errorf("%s is no http or https URL", text)
	}
	return strings.TrimSuffix(text, "/"), nil
}

func asShipID(text string) (string, error) {
	if !crew.IsShipID(text) {
		return "", fmt.Errorf("%s is no ship id: it starts with shp_", text)
	}
	return text, nil
}

// askedCrew is the fleet URL, ship id and secret from the flags, all three of which init needs.
func askedCrew(flags Flags) (fleetURL string, shipID string, err error) {
	var missing []string
	for _, flag := range []struct{ name, value string }{{"--fleet-url", flags.FleetURL}, {"--ship-id", flags.ShipID}, {"--secret", flags.Secret}} {
		if flag.value == "" {
			missing = append(missing, flag.name)
		}
	}
	switch len(missing) {
	case 0:
	case 1:
		return "", "", fmt.Errorf("init needs --fleet-url, --ship-id and --secret: %s is missing", missing[0])
	default:
		return "", "", fmt.Errorf("init needs --fleet-url, --ship-id and --secret: %s and %s are missing", strings.Join(missing[:len(missing)-1], ", "), missing[len(missing)-1])
	}
	if fleetURL, err = asFleetURL(strings.TrimSpace(flags.FleetURL)); err != nil {
		return "", "", err
	}
	if shipID, err = asShipID(strings.TrimSpace(flags.ShipID)); err != nil {
		return "", "", err
	}
	return fleetURL, shipID, nil
}

// missingInitFlags names all unanswered choices when no terminal is available.
func (i Init) missingInitFlags(flags Flags) []string {
	var missing []string
	if flags.Harnesses == nil {
		missing = append(missing, "--harnesses")
	}
	if !hasRepositoryChoice(flags) && !flags.IsYes {
		missing = append(missing, "--repositories, --repositories-in or --no-repositories")
	}
	if _, err := crew.Read(i.Paths.CrewToken); err != nil {
		for _, flag := range []struct{ name, value string }{{"--fleet-url", flags.FleetURL}, {"--ship-id", flags.ShipID}, {"--secret", flags.Secret}} {
			if flag.value == "" {
				missing = append(missing, flag.name)
			}
		}
	}
	return missing
}

// register registers the trierarch's ship; a ship crewed already was registered by its setup line run elsewhere, and the refusal says how to go on.
func (i Init) register(fleetURL string, shipID string, secret string, pluginShipID string) (string, error) {
	crewToken, err := i.Register(fleetURL, shipID, secret)
	var refusal *fleet.Refusal
	if errors.As(err, &refusal) && refusal.Code == "CONFLICT" {
		plugin := ""
		if pluginShipID != "" {
			plugin = " --plugin-ship-id " + pluginShipID
		}
		return "", fmt.Errorf("%s is crewed already: its setup line ran on another computer, or there as another user. Run that setup line there again to finish its setup, or Release %s on its page in the console and run init here with its new secret: aeolus-trierarch init --fleet-url %s --ship-id %s%s --secret <its new secret>", shipID, shipID, fleetURL, shipID, plugin)
	}
	return crewToken, err
}

func (i Init) Run(flags Flags) (Report, error) {
	if err := i.checkMachine(); err != nil {
		return Report{}, err
	}
	current := config.Initial()
	if _, err := os.Stat(i.Paths.Config); err == nil {
		loaded, err := config.Load(i.Paths.Config)
		if err != nil {
			return Report{}, err
		}
		current = loaded
	} else if !errors.Is(err, os.ErrNotExist) {
		return Report{}, err
	}
	var terminal io.ReadWriteCloser
	var reader *bufio.Reader
	if (flags.Harnesses == nil || (!flags.IsYes && (flags.Unattended == nil || !hasRepositoryChoice(flags)))) && i.OpenTerminal != nil {
		opened, err := i.OpenTerminal()
		if err == nil {
			terminal = opened
			defer terminal.Close()
			reader = bufio.NewReader(terminal)
		}
	}
	selection, err := i.selectHarnesses(flags, current, terminal, reader)
	if err != nil {
		return Report{}, err
	}
	repositories, err := i.selectRepositories(context.Background(), flags, current, reader, terminal)
	if err != nil {
		return Report{}, err
	}
	pluginShipID := strings.TrimSpace(flags.PluginShipID)
	if pluginShipID != "" {
		if _, err := asShipID(pluginShipID); err != nil {
			return Report{}, err
		}
	}
	report := Report{Trusted: []string{}, CodexTrusted: []string{}, CodexHooksTrusted: []string{}, Said: []string{}}
	say := func(line string) { report.Said = append(report.Said, line) }
	if _, ok := selection.harnesses["copilot"]; ok {
		say("! Copilot: sign-in cannot be checked; run copilot login if not done. Copilot always runs without asking, headless.")
	}

	if err := i.installPlugins(selection, say); err != nil {
		return Report{}, err
	}

	// The ship: registered once per machine, never again.
	kept, keptErr := crew.Read(i.Paths.CrewToken)
	isPluginShipNew := false
	isRegisteredAgain := false
	if keptErr != nil {
		fleetURL, shipID, err := askedCrew(flags)
		if err != nil {
			return Report{}, err
		}
		crewToken, err := i.register(fleetURL, shipID, flags.Secret, pluginShipID)
		if err != nil {
			return Report{}, err
		}
		if err := crew.Write(i.Paths.CrewToken, crew.File{FleetURL: fleetURL, ShipID: shipID, PluginShipID: pluginShipID, CrewToken: crewToken}); err != nil {
			return Report{}, err
		}
		report.FleetURL, report.ShipID = fleetURL, shipID
		say(fmt.Sprintf("Registered %s at %s: its crew token is kept in %s, readable by you only. The secret is written nowhere.", shipID, fleetURL, i.Paths.CrewToken))
	} else {
		report.IsSetUpAlready = true
		report.FleetURL, report.ShipID = kept.FleetURL, kept.ShipID
		ship := "its ship"
		if kept.ShipID != "" {
			ship = kept.ShipID
		}
		crews := fmt.Sprintf("the trierarch crews %s at %s", ship, kept.FleetURL)
		// The setup line run again names the ship this machine crews: its setup may not have finished.
		isSetupLineAgain := kept.ShipID != "" && strings.TrimSpace(flags.ShipID) == kept.ShipID && (flags.FleetURL == "" || strings.TrimSuffix(strings.TrimSpace(flags.FleetURL), "/") == kept.FleetURL)
		if !isSetupLineAgain && (flags.ShipID != "" || flags.Secret != "") {
			return Report{}, fmt.Errorf("this machine is set up already: %s. init never registers again: to register another ship, remove %s first", crews, i.Paths.CrewToken)
		}
		crewToken := kept.CrewToken
		if isSetupLineAgain {
			held, err := i.IsLeaseHeld(kept.FleetURL, kept.CrewToken)
			if err != nil {
				return Report{}, err
			}
			if held {
				say(fmt.Sprintf("The trierarch crews %s at %s already, so init registers nothing and goes on with the rest of the setup.", kept.ShipID, kept.FleetURL))
			} else {
				if flags.Secret == "" {
					return Report{}, fmt.Errorf("%s was released since this machine registered it: run init with its new secret (--secret)", kept.ShipID)
				}
				keptPlugin := pluginShipID
				if keptPlugin == "" {
					keptPlugin = kept.PluginShipID
				}
				if crewToken, err = i.register(kept.FleetURL, kept.ShipID, flags.Secret, keptPlugin); err != nil {
					return Report{}, err
				}
				isRegisteredAgain = true
				say(fmt.Sprintf("%s was released since this machine registered it, so init registered it again at %s: its crew token is kept in %s, readable by you only. The secret is written nowhere.", kept.ShipID, kept.FleetURL, i.Paths.CrewToken))
			}
		} else {
			say(fmt.Sprintf("This machine is set up already: %s.", crews))
		}
		// A machine joined before the trusted repositories takes them once it knows the trierarch plugin's ship.
		isPluginShipNew = pluginShipID != "" && pluginShipID != kept.PluginShipID
		if isPluginShipNew || isRegisteredAgain {
			if kept.ShipID == "" {
				return Report{}, fmt.Errorf("the crew file at %s lacks its ship id: remove it and run aeolus-trierarch init with the setup line", i.Paths.CrewToken)
			}
			keptPlugin := pluginShipID
			if keptPlugin == "" {
				keptPlugin = kept.PluginShipID
			}
			if err := crew.Write(i.Paths.CrewToken, crew.File{FleetURL: kept.FleetURL, ShipID: kept.ShipID, PluginShipID: keptPlugin, CrewToken: crewToken}); err != nil {
				return Report{}, err
			}
		}
	}
	if pluginShipID != "" {
		say(fmt.Sprintf("It takes the trusted repositories from the trierarch plugin's ship %s.", pluginShipID))
	}
	if err := os.MkdirAll(i.Paths.Home, 0o700); err != nil {
		return Report{}, err
	}
	if err := config.WriteSchema(i.Paths.ConfigSchema); err != nil {
		return Report{}, err
	}
	// The key the trierarch plugin seals each secret to: made once, kept across inits, so what was sealed to it still opens.
	if _, err := secrets.LoadOrMake(i.Paths.SealingKey); err != nil {
		return Report{}, err
	}

	// Keep repositories and harness options; save the answers that changed.
	var configuration config.Configuration
	if _, err := os.Stat(i.Paths.Config); errors.Is(err, os.ErrNotExist) {
		configuration = config.Initial()
		configuration.Harnesses = selection.harnesses
		configuration.Caps = selection.caps
		configuration.Repositories = repositories
		if err := config.Write(i.Paths.Config, configuration); err != nil {
			return Report{}, err
		}
		report.Configuration = "written"
		say(fmt.Sprintf("Configuration written at %s.", i.Paths.Config))
	} else {
		loaded, err := config.Load(i.Paths.Config)
		if err != nil {
			return Report{}, err
		}
		configuration = loaded
		report.Configuration = "kept"
		if !reflect.DeepEqual(loaded.Harnesses, selection.harnesses) || loaded.Caps != selection.caps || !reflect.DeepEqual(loaded.Repositories, repositories) {
			configuration.Harnesses = selection.harnesses
			configuration.Caps = selection.caps
			configuration.Repositories = repositories
			if err := config.Write(i.Paths.Config, configuration); err != nil {
				return Report{}, err
			}
			report.Configuration = "written"
			say(fmt.Sprintf("Configuration written at %s.", i.Paths.Config))
		}
	}
	if len(configuration.Repositories) == 0 && len(configuration.Folders) == 0 {
		say("It has no repository or folder yet, so it can crew no request: add one with aeolus-trierarch add.")
	}

	root := configuration.ShipsRoot
	if root == "" {
		root = i.Paths.Ships
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return Report{}, err
	}
	trusted, err := i.setUpClaudeCode(configuration, root)
	if err != nil {
		return Report{}, err
	}
	report.Trusted = trusted
	if len(trusted) > 0 {
		say(fmt.Sprintf("Claude Code trusts %s, so a session there starts with no trust question, and its onboarding is complete, so it shows no first-run screen.", strings.Join(trusted, ", ")))
	}
	report.CodexTrusted, report.CodexHooksTrusted = i.setUpCodex(configuration, root, say)

	// What each harness offers, detected on this machine and kept apart from the configuration (#365).
	harnesses := slices.Sorted(maps.Keys(configuration.Harnesses))
	detected, err := i.Detect(harnesses, detection.ByStart)
	if err != nil {
		return Report{}, err
	}
	for _, line := range strings.Split(detection.Describe(harnesses, detected), "\n") {
		say(line)
	}

	// The service: installed when it is not, rewritten as this trierarch writes it when it is, and restarted when it should read a new crew file.
	status, err := i.Service.Status()
	if err != nil {
		return Report{}, err
	}
	report.Service = "unchanged"
	switch {
	case !status.IsInstalled:
		if err := i.Service.Install(); err != nil {
			return report, i.serviceError(err)
		}
		report.Service = "installed"
	case report.Configuration != "kept" || isPluginShipNew || isRegisteredAgain:
		if err := i.Service.Rewrite(); err != nil {
			return Report{}, err
		}
		if err := i.Service.Restart(); err != nil {
			return report, i.serviceError(err)
		}
		report.Service = "restarted"
	default:
		if err := i.Service.Rewrite(); err != nil {
			return Report{}, err
		}
	}
	if err := i.waitForService(); err != nil {
		return report, i.serviceError(err)
	}
	say(fmt.Sprintf("The service stayed up for 10 seconds and starts again at every login (%s). See it with aeolus-trierarch status.", status.File))
	return report, nil
}

func (i Init) serviceError(err error) error {
	if i.LastLog != nil {
		if last := i.LastLog(); last != "" {
			return fmt.Errorf("%w: last log line: %s", err, last)
		}
	}
	return err
}

func (i Init) waitForService() error {
	now := i.Now
	if now == nil {
		now = time.Now
	}
	start := now()
	var stableSince time.Time
	var pid, lastPID, changes, baseline int
	first := true
	var reason error = errors.New("service is not running")
	for {
		status, err := i.Service.Status()
		if err != nil {
			return err
		}
		at := now()
		if first {
			baseline = status.Restarts
			first = false
		}
		if !status.IsRunning || status.PID <= 0 {
			pid = 0
			reason = errors.New("service is not running")
		} else {
			if status.PID != pid {
				if lastPID != 0 && status.PID != lastPID {
					changes++
				}
				pid, lastPID, stableSince = status.PID, status.PID, at
			}
			running, ok := readRunning(i.Paths.Running)
			switch {
			case !ok || running.PID != pid:
				reason = errors.New("running.json does not name the service process")
			case running.Version != Version:
				reason = fmt.Errorf("service version %s does not match %s", running.Version, Version)
			case !running.FirstReportAccepted:
				reason = errors.New("the first report was not accepted")
			case at.Sub(stableSince) < 10*time.Second:
				reason = errors.New("service did not keep one process for 10 seconds")
			default:
				kept, err := crew.Read(i.Paths.CrewToken)
				if err != nil {
					return err
				}
				held, err := i.IsLeaseHeld(kept.FleetURL, kept.CrewToken)
				if err != nil {
					return fmt.Errorf("check lease: %w", err)
				}
				if !held {
					return errors.New("lease is not valid")
				}
				return nil
			}
		}
		if at.Sub(start) >= 30*time.Second {
			restarts := max(changes, status.Restarts-baseline)
			if restarts > 0 {
				return fmt.Errorf("service restarted %d times in 30 seconds: %w", restarts, reason)
			}
			return reason
		}
		i.Sleep()
	}
}

// installPlugins installs the aeolus-fleet plugin of each picked harness at the tag of this version, leaving one already at it as it is. It runs before anything is registered, so a failure leaves the fleet as it was.
func (i Init) installPlugins(selection harnessSelection, say func(line string)) error {
	tag := "v" + Version
	for _, state := range i.harnessStates() {
		if _, ok := selection.harnesses[state.name]; !ok {
			continue
		}
		if i.Plugins.Version(state.name) == Version {
			say(fmt.Sprintf("The aeolus-fleet plugin for %s is on %s already.", state.label, Version))
			continue
		}
		if err := i.Plugins.Update(state.name, tag); err != nil {
			return fmt.Errorf("the aeolus-fleet plugin was not installed for %s: %w. Nothing is registered: fix what it says, then run the same line again", state.label, err)
		}
		say(fmt.Sprintf("Installed the aeolus-fleet plugin %s for %s.", Version, state.label))
	}
	return nil
}

// setUpClaudeCode trusts the place of ships/ and each configured repository and folder, and completes the onboarding, where the configuration offers Claude Code.
func (i Init) setUpClaudeCode(configuration config.Configuration, root string) ([]string, error) {
	if _, ok := configuration.Harnesses[claudeCode]; !ok {
		return []string{}, nil
	}
	repositories, folders := configuration.Places()
	places := append(append([]string{root}, repositories...), folders...)
	for _, place := range places {
		if err := i.ClaudeCode.Trust(place); err != nil {
			return nil, err
		}
	}
	if err := i.ClaudeCode.CompleteOnboarding(); err != nil {
		return nil, err
	}
	return places, nil
}

// setUpCodex answers Codex's one-time questions ahead on every run where the configuration offers Codex: each repository and folder trusted (a folder added since among them), and the aeolus-fleet plugin's hooks, which a plugin update changes. When Codex cannot be set up, init says so and goes on.
func (i Init) setUpCodex(configuration config.Configuration, root string, say func(line string)) ([]string, []string) {
	if _, ok := configuration.Harnesses[codex]; !ok {
		return []string{}, []string{}
	}
	repositories, folders := configuration.Places()
	places := append(append([]string{}, repositories...), folders...)
	notSetUp := func(err error) ([]string, []string) {
		say(fmt.Sprintf("Codex is not set up: %v. A Codex session waits on its trust questions until you run aeolus-trierarch init again.", err))
		return []string{}, []string{}
	}
	if err := i.Codex.Trust(places); err != nil {
		return notSetUp(err)
	}
	hooks, err := i.Codex.TrustAeolusHooks(root)
	if err != nil {
		return notSetUp(err)
	}
	if len(places) > 0 {
		say(fmt.Sprintf("Codex trusts each configured repository and folder, so a session there, or in a worktree of one, starts with no trust question: %s.", strings.Join(places, ", ")))
	}
	if len(hooks) > 0 {
		say(fmt.Sprintf("Codex trusts the aeolus-fleet plugin's %d new or changed hooks.", len(hooks)))
	} else {
		say("Codex trusts the aeolus-fleet plugin's hooks already.")
	}
	if hooks == nil {
		hooks = []string{}
	}
	return places, hooks
}

// hasSaidItsVersion waits until the process the service runs has said its version in running.json, 30 seconds at most.
func (i Init) hasSaidItsVersion() bool {
	return hasSaidItsVersion(i.Service, i.Paths.Running, i.Sleep)
}

func hasSaidItsVersion(service interface {
	Status() (service.Status, error)
}, runningFile string, sleep func()) bool {
	for check := 0; ; check++ {
		status, err := service.Status()
		running, isRead := readRunning(runningFile)
		if err == nil && status.IsRunning && isRead && running.PID == status.PID {
			return true
		}
		if check >= waitChecks {
			return false
		}
		sleep()
	}
}

// Running is what the running trierarch says of itself in running.json: its pid and its version, as it started.
type Running struct {
	PID                 int    `json:"pid"`
	Version             string `json:"version"`
	FirstReportAccepted bool   `json:"firstReportAccepted,omitempty"`
}

// RunningPID is the pid of the trierarch running.json at the path names, 0 when it names none.
func RunningPID(path string) int {
	running, _ := readRunning(path)
	return running.PID
}

func readRunning(path string) (Running, bool) {
	text, err := os.ReadFile(path)
	if err != nil {
		return Running{}, false
	}
	var running Running
	if json.Unmarshal(text, &running) != nil || running.PID <= 0 {
		return Running{}, false
	}
	return running, true
}

// ReportAccepted records that this process's first report reached the fleet.
func ReportAccepted(path string, pid int) error {
	running, ok := readRunning(path)
	if !ok || running.PID != pid {
		return errors.New("running file does not name this process")
	}
	if running.FirstReportAccepted {
		return nil
	}
	running.FirstReportAccepted = true
	text, err := json.Marshal(running)
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(text, '\n'), 0o644)
}
