// Package plugin is the aeolus-fleet plugin as a harness installed it, reached
// only through its own scripts (`aeolus-identity.sh`, `aeolus-push.sh`),
// never a copy of how it names its files: a session's identity, with the
// ship's socket and no crew token in it (decision 0026), its launch marker
// (#490), and a session that died.
package plugin

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// Plugin is where the plugin's scripts are, its data folder, and where its sessions' identities live (~/.aeolus/crews/<harness>).
type Plugin struct {
	Root  string
	Data  string
	Crews string
}

// DataFolder is the plugin's data folder in Claude Code's and Codex's plugins folders, as both name it.
const DataFolder = "aeolus-fleet-aeolus-fleet"

var releaseVersion = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

func versionParts(version string) []int {
	parts := []int{}
	for _, part := range strings.Split(version, ".") {
		number, _ := strconv.Atoi(part)
		parts = append(parts, number)
	}
	return parts
}

// Find is Claude Code's aeolus-fleet plugin: where AEOLUS_PLUGIN_ROOT and AEOLUS_PLUGIN_DATA name it, else the newest version in its plugin cache, following CLAUDE_CONFIG_DIR as Claude Code does.
func Find(homeDirectory string, env map[string]string) (Plugin, error) {
	plugins := filepath.Join(homeDirectory, ".claude", "plugins")
	if directory := env["CLAUDE_CONFIG_DIR"]; directory != "" {
		plugins = filepath.Join(directory, "plugins")
	}
	return newestIn(plugins, Plugin{Root: env["AEOLUS_PLUGIN_ROOT"], Data: env["AEOLUS_PLUGIN_DATA"], Crews: crewsOf(homeDirectory, "claude-code")}, "Claude Code", "AEOLUS_PLUGIN_ROOT")
}

// FindCodex is Codex's aeolus-fleet plugin: where AEOLUS_CODEX_PLUGIN_ROOT and AEOLUS_CODEX_PLUGIN_DATA name it, else the newest version in its plugin cache, following CODEX_HOME as Codex does.
func FindCodex(homeDirectory string, env map[string]string) (Plugin, error) {
	codexHome := env["CODEX_HOME"]
	if codexHome == "" {
		codexHome = filepath.Join(homeDirectory, ".codex")
	}
	return newestIn(filepath.Join(codexHome, "plugins"), Plugin{Root: env["AEOLUS_CODEX_PLUGIN_ROOT"], Data: env["AEOLUS_CODEX_PLUGIN_DATA"], Crews: crewsOf(homeDirectory, "codex")}, "Codex", "AEOLUS_CODEX_PLUGIN_ROOT")
}

// FindCopilot is Copilot's aeolus-fleet plugin: one folder in its installed-plugins folder, with no version in the path, and the data folder Copilot gives its hooks, both in COPILOT_HOME or ~/.copilot, unless AEOLUS_COPILOT_PLUGIN_ROOT and AEOLUS_COPILOT_PLUGIN_DATA name others. Unlike Claude Code's and Codex's, a missing one does not stop the trierarch at start: IsInstalled says so at each use, and the machine offers Copilot once it is installed (#1212).
func FindCopilot(homeDirectory string, env map[string]string) Plugin {
	copilotHome := env["COPILOT_HOME"]
	if copilotHome == "" {
		copilotHome = filepath.Join(homeDirectory, ".copilot")
	}
	plugin := Plugin{Root: env["AEOLUS_COPILOT_PLUGIN_ROOT"], Data: env["AEOLUS_COPILOT_PLUGIN_DATA"], Crews: crewsOf(homeDirectory, "copilot")}
	if plugin.Root == "" {
		plugin.Root = filepath.Join(copilotHome, "installed-plugins", "aeolus-fleet", "aeolus-fleet")
	}
	if plugin.Data == "" {
		plugin.Data = filepath.Join(copilotHome, "plugin-data", "aeolus-fleet", "aeolus-fleet")
	}
	return plugin
}

// crewsOf is where the plugin keeps the identities of the harness's sessions (decision 0015).
func crewsOf(homeDirectory string, harness string) string {
	return filepath.Join(homeDirectory, ".aeolus", "crews", harness)
}

// newestIn is the plugin as given, its data folder in the harness's plugins folder when none is given, and its root the newest version in that folder's cache when none is given.
func newestIn(plugins string, plugin Plugin, harness string, rootVariable string) (Plugin, error) {
	if plugin.Data == "" {
		plugin.Data = filepath.Join(plugins, "data", DataFolder)
	}
	if plugin.Root != "" {
		return plugin, nil
	}
	cache := filepath.Join(plugins, "cache", "aeolus-fleet", "aeolus-fleet")
	folders, _ := os.ReadDir(cache)
	versions := []string{}
	for _, folder := range folders {
		if releaseVersion.MatchString(folder.Name()) {
			versions = append(versions, folder.Name())
		}
	}
	if len(versions) == 0 {
		return Plugin{}, fmt.Errorf("the aeolus-fleet plugin is not installed for %s (nothing in %s): install it, or set %s", harness, cache, rootVariable)
	}
	slices.SortFunc(versions, func(a, b string) int { return slices.Compare(versionParts(a), versionParts(b)) })
	plugin.Root = filepath.Join(cache, versions[len(versions)-1])
	return plugin, nil
}

func (p Plugin) run(script string, folder string, input string, args ...string) (string, error) {
	command := exec.Command("bash", append([]string{filepath.Join(p.Root, "scripts", script)}, args...)...)
	command.Env = append(os.Environ(), "AEOLUS_FOLDER="+folder, "AEOLUS_DATA="+p.Data, "AEOLUS_CREWS="+p.Crews)
	command.Stdin = strings.NewReader(input)
	var stderr strings.Builder
	command.Stderr = &stderr
	out, err := command.Output()
	if err != nil {
		return string(out), fmt.Errorf("%s %s failed: %w: %s", script, strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return string(out), nil
}

// Identity is what a session's identity names: its fleet, its ship, the ship's socket it calls over, and its squadron.
type Identity struct {
	FleetURL string
	ShipID   string
	ShipName string
	Socket   string
	Squadron string
}

// WriteIdentity writes the folder's identity, woken by the trierarch; the crew token goes on stdin, never the command line (#822), for the plugin to keep its lease.
func (p Plugin) WriteIdentity(folder string, identity Identity, crewToken string) error {
	args := []string{"write", "--wake-by", "trierarch", "--socket", identity.Socket}
	args = append(args, identity.FleetURL, identity.ShipID, identity.ShipName)
	if identity.Squadron != "" {
		args = append(args, identity.Squadron)
	}
	_, err := p.run("aeolus-identity.sh", folder, crewToken, args...)
	return err
}

func (p Plugin) HasIdentity(folder string) bool {
	_, err := p.run("aeolus-identity.sh", folder, "", "show")
	return err == nil
}

// DeleteIdentity deletes the folder's identity; a folder with none, or a plugin that is lost, leaves nothing to do.
func (p Plugin) DeleteIdentity(folder string) error {
	if !p.HasIdentity(folder) {
		return nil
	}
	_, err := p.run("aeolus-identity.sh", folder, "", "delete")
	return err
}

// Turn is the session's turn as its plugin marks it: busy, idle, or unknown before one is marked.
func (p Plugin) Turn(folder string) string {
	marked, err := p.run("aeolus-identity.sh", folder, "", "turn")
	state, _, _ := strings.Cut(strings.TrimSpace(marked), " ")
	if err != nil || (state != "busy" && state != "idle") {
		return "unknown"
	}
	return state
}

// toHand are the states of a store entry the trierarch hands over (#756): received, handed and not confirmed, or to hand once more.
var toHand = []string{"received", "handed", "onceMore"}

// IsHolding is whether the session's store holds a message to hand; the store keeps one line per entry: its delivery id, its state and when.
func (p Plugin) IsHolding(folder string) bool {
	store, _ := p.run("aeolus-identity.sh", folder, "", "store")
	for _, line := range strings.Split(store, "\n") {
		if fields := strings.Fields(line); len(fields) > 1 && slices.Contains(toHand, fields[1]) {
			return true
		}
	}
	return false
}

// HandOverLine hands one message over (#756) and answers the line to type into the session; none when nothing is handed.
func (p Plugin) HandOverLine(folder string) (string, bool) {
	return p.lineOf(folder, "hand")
}

// ForceOverLine hands a forced message over first (decision 0040); the plugin marks the stop before it hands over, so a stopped turn is not taken as one that died.
func (p Plugin) ForceOverLine(folder string) (string, bool) {
	return p.lineOf(folder, "force")
}

// lineOf runs aeolus-push.sh: exit 0 hands a message over and prints its line; anything else hands nothing.
func (p Plugin) lineOf(folder string, command string) (string, bool) {
	printed, err := p.run("aeolus-push.sh", folder, "", command)
	line := strings.TrimSpace(printed)
	return line, err == nil && line != ""
}

// ClearLaunch forgets the folder's launch marker, before a session is started for a new launch.
func (p Plugin) ClearLaunch(folder string) error {
	_, err := p.run("aeolus-identity.sh", folder, "", "launch", "clear")
	return err
}

// Launch is what a session did in its launch, as its marker says: started, active at its first tool call, or refused because a turn failed for a model not found, with the model the refusal names when it names one.
type Launch struct {
	IsStarted    bool
	IsActive     bool
	IsRefused    bool
	RefusedModel string
}

// LaunchSeen is what the folder's marker says of the launch given; nothing before the hooks marked anything of it.
func (p Plugin) LaunchSeen(folder string, launchID string) Launch {
	marker, err := p.run("aeolus-identity.sh", folder, "", "launch")
	if err != nil {
		return Launch{}
	}
	return launchOf(marker, launchID)
}

func launchOf(marker string, launchID string) Launch {
	lines := strings.Split(marker, "\n")
	if lines[0] != "launch "+launchID {
		return Launch{}
	}
	seen := Launch{}
	for _, line := range lines[1:] {
		seen.IsStarted = seen.IsStarted || strings.HasPrefix(line, "started ")
		seen.IsActive = seen.IsActive || strings.HasPrefix(line, "active ")
		if fields := strings.Fields(line); len(fields) > 0 && fields[0] == "refused" && !seen.IsRefused {
			seen.IsRefused = true
			if len(fields) > 2 {
				seen.RefusedModel = fields[2]
			}
		}
	}
	return seen
}

// SessionDied tells the plugin's store the folder's session died, so it marks what that session held for the next one (#756).
func (p Plugin) SessionDied(folder string) error {
	_, err := p.run("aeolus-push.sh", folder, "", "died")
	return err
}

// IsInstalled says whether the plugin's scripts are where it was found: a session cannot start without them (#827).
func (p Plugin) IsInstalled() error {
	if _, err := os.Stat(filepath.Join(p.Root, "scripts", "aeolus-identity.sh")); errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("the aeolus-fleet plugin's scripts are not at %s", filepath.Join(p.Root, "scripts"))
	}
	return nil
}

// usageExit is the exit of a plugin script that does not know the command it was given, as a plugin older than the launch marker answers `launch`.
const usageExit = 2

// MarksLaunches is whether the plugin keeps launch markers (#490): one older than them answers `launch` with its usage. It is asked for the crews folder itself, which no session crews, so the answer is only whether the command is known. It fails when the plugin cannot be found at all (#1212), when it is not known what it marks.
func (p Plugin) MarksLaunches() (bool, error) {
	if err := p.IsInstalled(); err != nil {
		return false, err
	}
	command := exec.Command("bash", filepath.Join(p.Root, "scripts", "aeolus-identity.sh"), "launch")
	command.Env = append(os.Environ(), "AEOLUS_FOLDER="+p.Crews, "AEOLUS_DATA="+p.Data, "AEOLUS_CREWS="+p.Crews)
	err := command.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode() != usageExit, nil
	}
	return err == nil, err
}
