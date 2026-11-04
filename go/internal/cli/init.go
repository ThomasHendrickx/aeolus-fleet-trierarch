package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/fleet"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
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
// configuration, offering Codex too where it is installed; makes Claude Code
// and Codex ready to run unattended; and installs the
// service. Run again with the same setup line, it registers nothing and goes
// on with a setup that did not finish, registering its ship again only once it
// was released. It asks nothing: every default is taken.
type Init struct {
	Paths                 paths.Paths
	Platform              string
	IsSsMissing           bool
	IsClaudeCodeInstalled bool
	IsClaudeCodeSignedIn  bool
	ClaudeCode            ClaudeCode
	IsCodexInstalled      bool
	IsCodexSignedIn       bool
	Codex                 Codex
	Service               Service
	Register              func(fleetURL string, shipID string, secret string) (string, error)
	IsLeaseHeld           func(fleetURL string, crewToken string) (bool, error)
	// Sleep waits between reads of running.json; a test passes one that does not wait.
	Sleep func()
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
	if i.Platform != "linux" {
		return fmt.Errorf("this aeolus-trierarch knows systemd (Linux) only, not %s: set this machine up with the npm package, npx @aeolus-fleet/trierarch init", i.Platform)
	}
	if i.IsSsMissing {
		return errors.New("`ss` is not installed, and the trierarch needs it to tell which process calls a ship socket: without it no session starts. Install iproute2 (Debian and Ubuntu: sudo apt-get install iproute2), then run the setup line again")
	}
	if !i.IsClaudeCodeInstalled && !i.IsCodexInstalled {
		return errors.New("neither Claude Code nor Codex runs on this machine, so it could crew nothing. Install Claude Code (https://code.claude.com/docs/en/setup) or Codex (npm install -g @openai/codex) and be signed in to it, then run the setup line again")
	}
	if (i.IsClaudeCodeInstalled && i.IsClaudeCodeSignedIn) || (i.IsCodexInstalled && i.IsCodexSignedIn) {
		return nil
	}
	var steps []string
	if i.IsClaudeCodeInstalled {
		steps = append(steps, "Claude Code (run `claude` and sign in)")
	}
	if i.IsCodexInstalled {
		steps = append(steps, "Codex (run `codex login`)")
	}
	verb := "is"
	if len(steps) > 1 {
		verb = "are"
	}
	return fmt.Errorf("%s %s installed but not signed in, so no session could answer. Sign in: %s, then run the setup line again", strings.Join(steps, " and "), verb, strings.Join(steps, "; "))
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
	pluginShipID := strings.TrimSpace(flags.PluginShipID)
	if pluginShipID != "" {
		if _, err := asShipID(pluginShipID); err != nil {
			return Report{}, err
		}
	}
	report := Report{Trusted: []string{}, CodexTrusted: []string{}, CodexHooksTrusted: []string{}, Said: []string{}}
	say := func(line string) { report.Said = append(report.Said, line) }

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

	// The configuration: written when there is none, else kept.
	var configuration config.Configuration
	if _, err := os.Stat(i.Paths.Config); errors.Is(err, os.ErrNotExist) {
		configuration = config.Initial()
		// Offering Codex is the default answer where it is installed; launching it without approvals is not.
		if i.IsCodexInstalled {
			configuration.Harnesses[codex] = config.Harness{Flags: []string{}, Options: map[string]config.Option{}}
		}
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
	}
	if len(configuration.Repositories) == 0 && len(configuration.Folders) == 0 {
		say("It has no repository or folder yet, so it can crew no request: add one with aeolus-trierarch add.")
	}

	root := configuration.WorktreeRoot
	if root == "" {
		root = i.Paths.Worktrees
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

	// The service: installed when it is not, rewritten as this trierarch writes it when it is, and restarted when it should read a new crew file.
	status, err := i.Service.Status()
	if err != nil {
		return Report{}, err
	}
	report.Service = "unchanged"
	switch {
	case !status.IsInstalled:
		if err := i.Service.Install(); err != nil {
			return Report{}, err
		}
		report.Service = "installed"
		say(fmt.Sprintf("The trierarch runs, and starts again at every login (%s). See it with aeolus-trierarch status.", status.File))
		if !i.hasSaidItsVersion() {
			say(notSaidYet)
		}
	case report.Configuration != "kept" || isPluginShipNew || isRegisteredAgain:
		if err := i.Service.Rewrite(); err != nil {
			return Report{}, err
		}
		if err := i.Service.Restart(); err != nil {
			return Report{}, err
		}
		report.Service = "restarted"
		say("The trierarch restarted with the new configuration.")
		if !i.hasSaidItsVersion() {
			say(notSaidYet)
		}
	default:
		if err := i.Service.Rewrite(); err != nil {
			return Report{}, err
		}
	}
	return report, nil
}

// setUpClaudeCode trusts the worktree root and each configured repository and folder, and completes the onboarding, where the configuration offers Claude Code.
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
	PID     int    `json:"pid"`
	Version string `json:"version"`
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
