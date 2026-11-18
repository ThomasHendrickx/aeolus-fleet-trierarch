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
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
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
	// Folders are the folders used as they are that the setup line names, each --folder <name> <path>.
	Folders []FolderFlag
	// IsNoFolders answers the folder question with none: --no-folders.
	IsNoFolders bool
	// Service is the setup line's consent to install and start the service, yes or no; empty when unanswered.
	Service string
}

// FolderFlag is one --folder <name> <path> of the setup line.
type FolderFlag struct {
	Name string
	Path string
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
	Checks  []Check  `json:"checks"`
}

// Check is one line of the closing report.
type Check struct {
	Part   string `json:"part"`
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail"`
	Fix    string `json:"fix,omitempty"`
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
	Program               string
	Path                  string
	InstallVerification   string
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
	ShipName    func(fleetURL string, crewToken string) (string, error)
	// Sleep waits between reads of running.json; a test passes one that does not wait.
	Sleep   func()
	Now     func() time.Time
	LastLog func() string
	// Stop is closed when the process is told to stop: Ctrl+C at a setup question stops setup.
	Stop <-chan struct{}
	// Print writes a line of setup's progress where no terminal is open; nil writes nothing, as under --json.
	Print func(line string)
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
	for _, flag := range []struct{ name, value string }{{"--fleet-url", flags.FleetURL}, {"--ship-id", flags.ShipID}, {"--secret-stdin", flags.Secret}} {
		if flag.value == "" {
			missing = append(missing, flag.name)
		}
	}
	switch len(missing) {
	case 0:
	case 1:
		return "", "", fmt.Errorf("init needs --fleet-url, --ship-id and --secret-stdin: %s is missing", missing[0])
	default:
		return "", "", fmt.Errorf("init needs --fleet-url, --ship-id and --secret-stdin: %s and %s are missing", strings.Join(missing[:len(missing)-1], ", "), missing[len(missing)-1])
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
		for _, flag := range []struct{ name, value string }{{"--fleet-url", flags.FleetURL}, {"--ship-id", flags.ShipID}, {"--secret-stdin", flags.Secret}} {
			if flag.value == "" {
				missing = append(missing, flag.name)
			}
		}
	}
	return missing
}

// crewTokenNotSaved is the stop after the fleet registered this computer but its crew token could not be kept.
func crewTokenNotSaved(err error) error {
	return stopped("Not ready: the crew token the fleet answered could not be saved.", "Last error: "+err.Error(), "The fleet registered this computer, but it holds no crew token for it.", "Run the same setup line again, and follow the recovery instructions it gives.")
}

// register registers the trierarch's ship; a refusal of the fleet that a person can act on says what happened and what to run next.
func (i Init) register(fleetURL string, shipID string, secret string, pluginShipID string) (string, error) {
	crewToken, err := i.Register(fleetURL, shipID, secret)
	var refusal *fleet.Refusal
	if err == nil {
		return crewToken, nil
	}
	if !errors.As(err, &refusal) {
		return "", stopped(
			"The fleet did not confirm registration.",
			"It may have accepted it before the connection failed.",
			"Run the same setup line again. If it reports that the ship is already",
			"crewed here without a saved credential, use the recovery instructions",
			"on the computer's ship page. No service was started by this run.",
		)
	}
	line := "aeolus-trierarch init --fleet-url " + fleetURL + " --ship-id " + shipID
	if pluginShipID != "" {
		line += " --plugin-ship-id " + pluginShipID
	}
	switch refusal.Code {
	case "CONFLICT":
		//lint:ignore ST1005 Thomas approved this text verbatim, its capital and final period with it (#264).
		return "", fmt.Errorf("%s is crewed already, and this computer holds no crew token for it. Either an earlier setup here stopped before it saved the crew token, or the ship was set up on another computer or as another user. To crew it from here, Release %s on its page in the console and run init here with its new secret: %s --secret-stdin <<< '<its new secret>'. If it is set up elsewhere, run that setup line there again instead.", shipID, shipID, line)
	case "UNAUTHORIZED":
		//lint:ignore ST1005 Thomas approved this text verbatim, its capital with it (#264).
		return "", fmt.Errorf("The fleet at %s does not accept this secret for %s: it is wrong, or it is an old one the fleet no longer takes. Copy the ship's current secret from its page in the console (Release %s there for a new one), then run init here again: %s --secret-stdin <<< '<its current secret>'", fleetURL, shipID, shipID, line)
	}
	return crewToken, err
}

// checkedFlags refuses, before anything changes, a flag of the setup line that cannot be used.
func (i Init) checkedFlags(flags Flags) error {
	if _, err := positiveCap(flags.MaxShips, 1, "--max-ships"); err != nil {
		return err
	}
	if _, err := positiveCap(flags.MaxRunning, 1, "--max-running"); err != nil {
		return err
	}
	if flags.Service != "" && flags.Service != "yes" && flags.Service != "no" {
		return fmt.Errorf("--service takes yes or no, not %q", flags.Service)
	}
	if _, err := checkedFolderFlags(flags, i.home()); err != nil {
		return err
	}
	if pluginShipID := strings.TrimSpace(flags.PluginShipID); pluginShipID != "" {
		if _, err := asShipID(pluginShipID); err != nil {
			return err
		}
	}
	return nil
}

// isAskingAnything is whether a choice of the setup line is left for the wizard to ask.
func isAskingAnything(flags Flags) bool {
	if flags.Harnesses == nil {
		return true
	}
	if flags.IsYes {
		return false
	}
	return flags.Unattended == nil || !hasRepositoryChoice(flags) || (len(flags.Folders) == 0 && !flags.IsNoFolders) || flags.MaxShips == "" || flags.MaxRunning == "" || flags.Service == ""
}

// lineWriter keeps what is written until a line ends, so print gets whole lines.
type lineWriter struct {
	print   func(line string)
	pending string
}

func (l *lineWriter) Write(text []byte) (int, error) {
	l.pending += string(text)
	for {
		line, rest, isWhole := strings.Cut(l.pending, "\n")
		if !isWhole {
			return len(text), nil
		}
		l.print(line)
		l.pending = rest
	}
}

const (
	shipLimitCopy    = "The ship limit is how many ships this trierarch may keep on its list,\nincluding ships whose sessions are not running."
	sessionLimitCopy = "The session limit is how many sessions may run at the same time.\nOther ships wait for a place."
)

// selectLimits is part 3: how many ships the trierarch keeps on its list and how many sessions run at once, each explained before it is asked.
func (i Init) selectLimits(flags Flags, current config.Configuration, isRerun bool, w wizard, canAsk bool) (config.Caps, error) {
	w.part(3)
	caps := current.Caps
	for index, limit := range []struct {
		copy, question, help, flag, written string
		value                               *int
	}{
		{shipLimitCopy, "How many ships may it keep on its list?", "This limits how many ships this trierarch keeps on its list,\nincluding ships whose sessions are not running. Enter keeps %d.", "--max-ships", flags.MaxShips, &caps.Ships},
		{sessionLimitCopy, "How many sessions may run at once?", "This limits sessions running at the same time on this computer.\nOther ships wait for a place. Enter keeps %d.", "--max-running", flags.MaxRunning, &caps.Running},
	} {
		if index > 0 {
			w.say("")
		}
		setting := fmt.Sprintf(" Fresh default: %d.", *limit.value)
		if isRerun {
			setting = fmt.Sprintf(" Current setting: %d.", *limit.value)
		}
		w.say(limit.copy + setting)
		var err error
		switch {
		case limit.written != "":
			if *limit.value, err = positiveCap(limit.written, *limit.value, limit.flag); err != nil {
				return caps, stoppedBeforeRegistration(err)
			}
			w.say(fromTheSetupLine(strconv.Itoa(*limit.value)))
		case flags.IsYes || !canAsk:
			w.say(fmt.Sprintf("Using %d.", *limit.value))
		default:
			if *limit.value, err = w.number(limit.question, fmt.Sprintf(limit.help, *limit.value), *limit.value); err != nil {
				return caps, err
			}
		}
	}
	return caps, nil
}

// askService is part 4's consent: installing, or updating, and starting the service. No stops setup before joining, leaving a service there alone.
func (i Init) askService(flags Flags, status service.Status, w wizard, canAsk bool) error {
	w.part(4)
	w.say("The service runs the trierarch in the background and starts it again", "at login. It can start sessions when the fleet assigns work here.")
	question := "Install and start the service?"
	if status.IsInstalled {
		w.say("Yes updates and starts it. No stops before joining this computer;", "this run will not register it or change its service.")
		question = "Update and start the existing service?"
	} else {
		w.say("Yes installs and starts it. No stops before joining this computer;", "this run will not register it or install or start its service.")
	}
	w.say(filesMayRemain)
	isConsent := true
	switch {
	case flags.Service != "":
		isConsent = flags.Service == "yes"
		w.say(fromTheSetupLine(map[bool]string{true: "install and start the service", false: "do not install or start the service"}[isConsent]))
	case flags.IsYes || !canAsk:
		w.say("Default: install and start the service.")
	default:
		help := "The service keeps the trierarch running in the background, so the fleet\ncan start sessions here. Yes sets it up and starts it now. No stops\nsetup before joining; nothing is registered. Default: Yes."
		var err error
		if isConsent, err = w.yes(question, help, true); err != nil {
			return err
		}
	}
	if isConsent {
		w.say("")
		return nil
	}
	if status.IsInstalled {
		return stopped("Stopped: no registration or service change by this run.", "The existing service is unchanged and may still be running.", filesMayRemain, runAgainToContinue)
	}
	return stopped("Stopped before joining: no registration or service change by this run.", filesMayRemain, runAgainToContinue)
}

// joinedStop is a stop after the fleet registered this computer: what failed, and that the computer is joined without being ready.
func joinedStop(what string, err error, secrets ...string) error {
	return stopped("Not ready: "+what+".", "Last error: "+redacted(err.Error(), secrets...), "The computer is joined; this run did not start its service.", "Check: aeolus-trierarch status", "Fix the reported cause, then run the same setup line again.")
}

func (i Init) Run(flags Flags) (Report, error) {
	if err := i.checkMachine(); err != nil {
		return Report{}, stoppedBeforeRegistration(err)
	}
	if err := i.checkedFlags(flags); err != nil {
		return Report{}, stoppedBeforeRegistration(err)
	}
	current := config.Initial()
	isRerun := false
	if _, err := os.Stat(i.Paths.Config); err == nil {
		loaded, err := config.Load(i.Paths.Config)
		if err != nil {
			return Report{}, stoppedBeforeRegistration(err)
		}
		current, isRerun = loaded, true
	} else if !errors.Is(err, os.ErrNotExist) {
		return Report{}, stoppedBeforeRegistration(err)
	}
	// The lease of a machine set up already is checked before anything changes: before a clone and before a plugin update.
	kept, keptErr := crew.Read(i.Paths.CrewToken)
	// The setup line run again names the ship this machine crews: its setup may not have finished.
	isSetupLineAgain := keptErr == nil && kept.ShipID != "" && strings.TrimSpace(flags.ShipID) == kept.ShipID && (flags.FleetURL == "" || strings.TrimSuffix(strings.TrimSpace(flags.FleetURL), "/") == kept.FleetURL)
	isLeaseHeld := false
	if isSetupLineAgain {
		held, err := i.IsLeaseHeld(kept.FleetURL, kept.CrewToken)
		if err != nil {
			//lint:ignore ST1005 Thomas approved this text verbatim, its capital and final period with it (#264).
			return Report{}, fmt.Errorf("Could not check whether this machine still crews %s at %s: %w. Nothing was changed. Check that this computer is online and the fleet is up, then run the setup line again.", kept.ShipID, kept.FleetURL, err)
		}
		isLeaseHeld = held
	}
	var terminal io.ReadWriteCloser
	w := wizard{out: io.Discard}
	if i.Print != nil {
		w.out = &lineWriter{print: i.Print}
	}
	if isAskingAnything(flags) && i.OpenTerminal != nil {
		opened, err := i.OpenTerminal()
		if err == nil && opened != nil {
			terminal = opened
			defer terminal.Close()
			w = wizard{reader: bufio.NewReader(terminal), out: terminal, stop: i.Stop}
		}
	}
	canAsk := terminal != nil
	w.say(setupIntroduction)
	harnesses, err := i.selectHarnesses(flags, current, isRerun, w, canAsk)
	if err != nil {
		return Report{}, err
	}
	repositories, folders, cloned, err := i.selectRepositories(context.Background(), flags, current, w, canAsk)
	if err != nil {
		return Report{}, err
	}
	caps, err := i.selectLimits(flags, current, isRerun, w, canAsk)
	if err != nil {
		return Report{}, err
	}
	existing, err := i.Service.Status()
	if err != nil {
		return Report{}, stoppedBeforeRegistration(err)
	}
	if err := i.askService(flags, existing, w, canAsk); err != nil {
		return Report{}, err
	}
	pluginShipID := strings.TrimSpace(flags.PluginShipID)
	report := Report{Trusted: []string{}, CodexTrusted: []string{}, CodexHooksTrusted: []string{}, Said: []string{}}
	say := func(line string) { report.Said = append(report.Said, line) }

	if err := i.installPlugins(harnesses, w, flags.Secret); err != nil {
		return Report{}, err
	}

	w.say("Joining the fleet...")
	// The ship: registered once per machine, never again.
	isPluginShipNew := false
	isRegisteredAgain := false
	if keptErr != nil {
		fleetURL, shipID, err := askedCrew(flags)
		if err != nil {
			return Report{}, stoppedBeforeRegistration(err)
		}
		crewToken, err := i.register(fleetURL, shipID, flags.Secret, pluginShipID)
		if err != nil {
			return Report{}, err
		}
		if err := crew.Write(i.Paths.CrewToken, crew.File{FleetURL: fleetURL, ShipID: shipID, PluginShipID: pluginShipID, CrewToken: crewToken}); err != nil {
			return Report{}, crewTokenNotSaved(err)
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
		if !isSetupLineAgain && (flags.ShipID != "" || flags.Secret != "") {
			return Report{}, fmt.Errorf("this machine is set up already: %s. init never registers again: to register another ship, remove %s first", crews, i.Paths.CrewToken)
		}
		crewToken := kept.CrewToken
		if isSetupLineAgain {
			if isLeaseHeld {
				say(fmt.Sprintf("The trierarch crews %s at %s already, so init registers nothing and goes on with the rest of the setup.", kept.ShipID, kept.FleetURL))
			} else {
				if flags.Secret == "" {
					return Report{}, fmt.Errorf("%s was released since this machine registered it: run init with its new secret (--secret-stdin)", kept.ShipID)
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
				return Report{}, crewTokenNotSaved(err)
			}
		}
	}
	if pluginShipID != "" {
		say(fmt.Sprintf("It takes the trusted repositories from the trierarch plugin's ship %s.", pluginShipID))
	}
	w.say("Saving this computer's configuration...")
	notSaved := func(err error) error {
		return joinedStop("this computer's configuration could not be saved", err, flags.Secret)
	}
	if err := os.MkdirAll(i.Paths.Home, 0o700); err != nil {
		return Report{}, notSaved(err)
	}
	if err := config.WriteSchema(i.Paths.ConfigSchema); err != nil {
		return Report{}, notSaved(err)
	}
	// The key the trierarch plugin seals each secret to: made once, kept across inits, so what was sealed to it still opens.
	if _, err := secrets.LoadOrMake(i.Paths.SealingKey); err != nil {
		return Report{}, notSaved(err)
	}

	// Keep repositories and harness options; save the answers that changed.
	var configuration config.Configuration
	if _, err := os.Stat(i.Paths.Config); errors.Is(err, os.ErrNotExist) {
		configuration = config.Initial()
		configuration.Harnesses = harnesses
		configuration.Caps = caps
		configuration.Repositories = repositories
		configuration.Folders = folders
		if err := config.Write(i.Paths.Config, configuration); err != nil {
			return Report{}, notSaved(err)
		}
		report.Configuration = "written"
		say(fmt.Sprintf("Configuration written at %s.", i.Paths.Config))
	} else {
		loaded, err := config.Load(i.Paths.Config)
		if err != nil {
			return Report{}, notSaved(err)
		}
		configuration = loaded
		report.Configuration = "kept"
		if !reflect.DeepEqual(loaded.Harnesses, harnesses) || loaded.Caps != caps || !reflect.DeepEqual(loaded.Repositories, repositories) || !reflect.DeepEqual(loaded.Folders, folders) {
			configuration.Harnesses = harnesses
			configuration.Caps = caps
			configuration.Repositories = repositories
			configuration.Folders = folders
			if err := config.Write(i.Paths.Config, configuration); err != nil {
				return Report{}, notSaved(err)
			}
			report.Configuration = "written"
			say(fmt.Sprintf("Configuration written at %s.", i.Paths.Config))
		}
	}
	root := configuration.ShipsRoot
	if root == "" {
		root = i.Paths.Ships
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return Report{}, notSaved(err)
	}
	trusted, err := i.setUpClaudeCode(configuration, root)
	if err != nil {
		return Report{}, joinedStop("Claude Code could not be set up to trust this computer's workspaces", err, flags.Secret)
	}
	report.Trusted = trusted
	if len(trusted) > 0 {
		say(fmt.Sprintf("Claude Code trusts %s, so a session there starts with no trust question, and its onboarding is complete, so it shows no first-run screen.", strings.Join(trusted, ", ")))
	}
	report.CodexTrusted, report.CodexHooksTrusted = i.setUpCodex(configuration, root, say)

	// What each harness offers, detected on this machine and kept apart from the configuration (#365).
	names := slices.Sorted(maps.Keys(configuration.Harnesses))
	detected, err := i.Detect(names, detection.ByStart)
	if err != nil {
		return Report{}, joinedStop("what each agent tool offers could not be detected", err, flags.Secret)
	}
	for _, line := range strings.Split(detection.Describe(names, detected), "\n") {
		say(line)
	}

	// The service: installed when it is not, rewritten as this trierarch writes it when it is, and restarted when it should read a new crew file.
	w.say("Starting the service...")
	finish := func(pid int, err error) (Report, error) {
		w.say("")
		i.closingReport(&report, configuration, detected, cloned, pid, err)
		return report, err
	}
	status, err := i.Service.Status()
	if err != nil {
		return finish(0, i.serviceError(err))
	}
	report.Service = "unchanged"
	running, hasRunning := readRunning(i.Paths.Running)
	// A service another trierarch started, as on a machine moving to this one by its setup line, runs this one only once restarted.
	isAnotherVersion := status.IsRunning && hasRunning && running.Version != Version
	switch {
	case !status.IsInstalled:
		if err := i.Service.Install(); err != nil {
			return finish(0, i.serviceError(err))
		}
		report.Service = "installed"
	case report.Configuration != "kept" || isPluginShipNew || isRegisteredAgain || isAnotherVersion || (!status.IsRunning && !status.IsRestarting):
		if err := i.Service.Rewrite(); err != nil {
			return finish(0, i.serviceError(err))
		}
		if err := i.Service.Restart(); err != nil {
			return finish(0, i.serviceError(err))
		}
		report.Service = "restarted"
	default:
		if err := i.Service.Rewrite(); err != nil {
			return finish(0, i.serviceError(err))
		}
	}
	w.say("Checking that the service stays running (at least 10 seconds)...")
	if err := i.waitForService(); err != nil {
		return finish(0, i.serviceError(err))
	}
	status, _ = i.Service.Status()
	return finish(status.PID, nil)
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
	var reason error
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
func (i Init) installPlugins(harnesses map[string]config.Harness, w wizard, secrets ...string) error {
	tag := "v" + Version
	for _, state := range i.harnessStates() {
		if _, ok := harnesses[state.name]; !ok {
			continue
		}
		if i.Plugins.Version(state.name) == Version {
			w.say(fmt.Sprintf("The Aeolus Fleet plugin for %s is on %s already.", state.label, Version))
			continue
		}
		w.say(fmt.Sprintf("Installing the Aeolus Fleet plugin for %s...", state.label))
		if err := i.Plugins.Update(state.name, tag); err != nil {
			return stopped(
				fmt.Sprintf("The Aeolus Fleet plugin could not be installed for %s.", state.label),
				"The installer reported: "+redacted(err.Error(), secrets...),
				"Not joined: this run did not register the computer or change its service.",
				"Fix the reported cause, then run your setup line again.",
			)
		}
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
	return writeRunning(path, Running{PID: pid, Version: Version, FirstReportAccepted: true})
}

func writeRunning(path string, running Running) error {
	text, err := json.Marshal(running)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".running-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err := file.Chmod(0o644); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(append(text, '\n')); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}
