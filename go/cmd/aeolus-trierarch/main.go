// Command aeolus-trierarch is the Go trierarch (docs/design/trierarch-binary.md):
// one binary with no Node, built beside today's trierarch part by part
// against the contract suite. See internal/cli for its commands.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/attestation"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/checkouts"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/claudecode"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/cli"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/codex"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/copilot"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/fleet"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/folderprocess"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/keys"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/logfile"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/machineload"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/modelproxy"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/notices"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/peer"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/receiving"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/release"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/runpass"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/selfreport"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/service"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/servicelog"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/shipsocket"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/state"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/trust"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/trusted"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/usage"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/workspace"

	"golang.org/x/term"
)

func main() {
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	program, err := os.Executable()
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	if resolved, err := filepath.EvalSymlinks(program); err == nil {
		program = resolved
	}
	stop := make(chan struct{})
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-signals
		close(stop)
	}()
	environ := os.Environ()
	capLog(paths.Of(home, "").Logs)
	machine := cli.Machine{
		Environ:               environ,
		HomeDirectory:         home,
		Platform:              runtime.GOOS,
		ManagedSettings:       claudecode.ManagedSettings(),
		PID:                   os.Getpid(),
		IsClaudeCodeInstalled: claudecode.IsInstalled,
		IsClaudeCodeSignedIn:  claudecode.IsSignedIn,
		IsSsMissing: func() bool {
			_, err := exec.LookPath("ss")
			return runtime.GOOS == "linux" && err != nil
		},
		ClaudeCode: func(homeDirectory string, configDirectory string) cli.ClaudeCode {
			return claudecode.Of(homeDirectory, configDirectory)
		},
		IsCodexInstalled: codex.IsInstalled,
		IsCodexSignedIn:  codex.IsSignedIn,
		Codex:            func() cli.Codex { return codex.AppServer{Program: "codex", Version: cli.Version} },
		Service: func(at paths.Paths) cli.ServiceManager {
			if runtime.GOOS == "darwin" {
				return service.Launchd{HomeDirectory: home, Logs: at.Logs, Program: program, Environment: service.Environment(environ), UID: os.Getuid(), Exec: service.Run, Sleep: func() { time.Sleep(time.Second) }}
			}
			return service.Systemd{HomeDirectory: home, Logs: at.Logs, Program: program, Environment: service.Environment(environ), Exec: systemctl}
		},
		Register:    fleet.Register,
		IsLeaseHeld: fleet.IsLeaseHeld,
		Sleep:       func() { time.Sleep(time.Second) },
		Stop:        stop,
		CoreVersionRefusal: func(fleetURL string) string {
			return fleet.CoreVersionRefusal(fleetURL, cli.Version, fleet.MinimumCoreVersion)
		},
		NewPass: func(at paths.Paths, kept crew.File, configuration config.Configuration) (func(isKeyCutOff bool) error, error) {
			return newPass(at, kept, configuration, home, program)
		},
		PassEvery: passEvery,
		OwnShip: func(kept crew.File) receiving.Ship {
			return fleet.Client{URL: kept.FleetURL, CrewToken: kept.CrewToken, Model: "@aeolus-fleet/trierarch@" + cli.Version}
		},
		Trusted: func(at paths.Paths, configuration config.Configuration) receiving.Keeper {
			return trustedRepositories(at, configuration, home)
		},
		Sessions: func(at paths.Paths) cli.Sessions { return sessionRuntime(at, program) },
		Log:      logLine,
		ReadKey:  readKey,
		CheckKey: func(harness string, key string) keys.Checked {
			return keys.Check(harness, key, "")
		},
		CheckNow: checkNow,
		Program:  program,
		Releases: func() cli.Releases { return releases(environ) },
		Plugins: func() cli.Plugins {
			return plugins{home: home, env: environment()}
		},
		Trierarch: runTrierarch,
		ServiceLog: func(at paths.Paths) servicelog.Log {
			return servicelog.Of(runtime.GOOS, filepath.Join(at.Logs, "trierarch.log"), servicelog.RunProgram, servicelog.StreamProgram, 500*time.Millisecond)
		},
		Print:      func(line string) { fmt.Fprintln(stdout, line) },
		IsTerminal: isTerminal(os.Stdout),
		StartedAt:  startedAt,
		Detect: func(at paths.Paths, harnesses []string, by detection.By) (detection.Detected, error) {
			warn := func(line string) { fmt.Fprintln(os.Stderr, line) }
			return detectionOf(at, environment(), home, warn).Detect(context.Background(), harnesses, by)
		},
	}
	output, code := cli.Main(os.Args[1:], machine)
	// While the trierarch is down a session's call gets no answer, as when the fleet is down (decision 0026).
	if opened != nil {
		opened.CloseAll()
	}
	if output != "" {
		fmt.Fprintln(stdout, output)
	}
	os.Exit(code)
}

// releaseSource is the GitHub Release of this system and chip upgrade takes a version from; AEOLUS_TRIERARCH_RELEASES_URL and AEOLUS_TRIERARCH_TRUSTED_ROOT name another API and trusted root, as the contract suite's.
type releaseSource struct {
	source release.Source
	// refusal is why no release is taken: a trusted root that could not be read.
	refusal error
}

func releases(environ []string) releaseSource {
	env := map[string]string{}
	for _, entry := range environ {
		if name, value, ok := strings.Cut(entry, "="); ok {
			env[name] = value
		}
	}
	source := release.Source{API: release.GitHub, Repository: release.Repository, Trusted: attestation.PublicGood(), Client: &http.Client{Timeout: 5 * time.Minute}}
	if api := env["AEOLUS_TRIERARCH_RELEASES_URL"]; api != "" {
		source.API = strings.TrimSuffix(api, "/")
	}
	if file := env["AEOLUS_TRIERARCH_TRUSTED_ROOT"]; file != "" {
		text, err := os.ReadFile(file)
		if err != nil {
			return releaseSource{refusal: fmt.Errorf("read the trusted root AEOLUS_TRIERARCH_TRUSTED_ROOT names: %w", err)}
		}
		trusted, err := attestation.ParseTrustedRoot(text)
		if err != nil {
			return releaseSource{refusal: err}
		}
		source.Trusted = trusted
	}
	return releaseSource{source: source}
}

func (r releaseSource) Latest() (string, error) {
	if r.refusal != nil {
		return "", r.refusal
	}
	return r.source.Latest(context.Background())
}

func (r releaseSource) Fetch(version string) ([]byte, error) {
	if r.refusal != nil {
		return nil, r.refusal
	}
	return r.source.Fetch(context.Background(), version, runtime.GOOS, runtime.GOARCH)
}

// plugins is the aeolus-fleet plugin of Claude Code and of Codex, as upgrade updates it.
type plugins struct {
	home string
	env  map[string]string
}

func (p plugins) Update(harness string, tag string) error {
	switch harness {
	case "claude-code":
		return claudecode.PluginUpdateOf(p.home, p.env["CLAUDE_CONFIG_DIR"]).Update(tag)
	case "codex":
		// The running trierarch took its plugin scripts from the newest version when it started.
		running := paths.Of(p.home, "").Running
		return codex.PluginUpdateOf(p.home, p.env["CODEX_HOME"], func() int { return cli.RunningPID(running) }).Update(tag)
	}
	return fmt.Errorf("the plugin for %s is not updated by upgrade", harness)
}

func (p plugins) Version(harness string) string {
	switch harness {
	case "claude-code":
		found, err := plugin.Find(p.home, p.env)
		if err != nil {
			return ""
		}
		return claudecode.PluginVersion(found.Root)
	case "codex":
		found, err := plugin.FindCodex(p.home, p.env)
		if err != nil {
			return ""
		}
		return codex.PluginVersion(found.Root)
	case "copilot":
		return copilot.PluginVersion(plugin.FindCopilot(p.home, p.env).Root)
	}
	return ""
}

// runTrierarch runs a trierarch file with the words, as the plugin step of an upgrade when isPluginStep: its stdout and its exit status, 127 when it could not run at all.
func runTrierarch(program string, isPluginStep bool, words ...string) (string, int) {
	command := exec.Command(program, words...)
	command.Env = slices.DeleteFunc(os.Environ(), func(entry string) bool { return strings.HasPrefix(entry, cli.PluginStepVariable+"=") })
	if isPluginStep {
		command.Env = append(command.Env, cli.PluginStepVariable+"=1")
	}
	var stderr strings.Builder
	command.Stderr = &stderr
	output, err := command.Output()
	var exited *exec.ExitError
	switch {
	case err == nil:
		return string(output), 0
	case errors.As(err, &exited):
		return string(output) + stderr.String(), exited.ExitCode()
	default:
		return err.Error(), 127
	}
}

// opened are the ships' sockets run opened, closed once it ends.
var opened *shipsocket.Sockets

// shipSockets are each ship's socket for its session's fleet calls, with its crew token from the state at each call (decision 0026). A caller is allowed only under the ship's own hold, or under the trierarch itself, as its aeolus-push.sh.
func shipSockets(at paths.Paths, fleetURL string, running sessions.Runtime, checked checkouts.Git) *shipsocket.Sockets {
	store := state.File{Path: at.State}
	trierarch := os.Getpid()
	return shipsocket.New(shipsocket.Options{
		Root:     at.Sockets,
		FleetURL: fleetURL,
		CrewTokenOf: func(shipID string) string {
			saved, err := store.Load()
			if err != nil {
				return ""
			}
			return saved.Entries[shipID].CrewToken
		},
		MayCall: func(shipID string, pid int) bool {
			roots := []int{trierarch}
			if root := running.Root(shipID); root != 0 {
				roots = append(roots, root)
			}
			return pid > 0 && peer.IsUnder(pid, roots)
		},
		Log:              logLine,
		RefreshCheckouts: checked.Refresh,
	})
}

// held is the trusted repositories this process holds, loaded once and shared by the receiving loop that accepts a list and the passes that offer, report and crew from it.
var (
	held     *trusted.File
	holdOnce sync.Once
)

// trustedRepositories are the trusted repositories the trierarch plugin sent last (aeolus-fleet#384): each one's clone is trusted as the list arrives, as adding a place trusts it (#381).
func trustedRepositories(at paths.Paths, configuration config.Configuration, home string) *trusted.File {
	holdOnce.Do(func() {
		env := environment()
		held = &trusted.File{Path: at.TrustedRepositories, ClonesRoot: at.Repositories, TrustClones: func(clones []string) error {
			if _, ok := configuration.Harnesses["claude-code"]; ok {
				setup := claudecode.Of(home, env["CLAUDE_CONFIG_DIR"])
				for _, clone := range clones {
					if err := setup.Trust(clone); err != nil {
						return err
					}
				}
			}
			if _, ok := configuration.Harnesses["codex"]; ok && len(clones) > 0 {
				// As add does: a clone Codex does not trust is not offered until it does (#381).
				if err := (codex.AppServer{Program: "codex", Version: cli.Version}).Trust(clones); err != nil {
					logLine("Codex does not trust the trusted repositories' clones: " + err.Error())
				}
			}
			return nil
		}}
		held.Load()
	})
	return held
}

// modelProxy is the model proxy on this machine (headless H16), started as a hold is.
func modelProxy(at paths.Paths, program string) modelproxy.Runtime {
	return modelproxy.Runtime{Folder: at.Proxy, Sessions: at.Sessions, Keys: at.Keys, Program: []string{program}, Version: cli.Version, Launch: sessions.Launch(runtime.GOOS, os.Getenv("INVOCATION_ID"), sessions.SystemdVersion())}
}

// readKey is the key piped in, or typed at a terminal, asked on stderr so stdout holds the answer alone, and not shown as typed.
func readKey() (string, error) {
	info, err := os.Stdin.Stat()
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeCharDevice == 0 {
		typed, err := io.ReadAll(os.Stdin)
		return string(typed), err
	}
	fmt.Fprint(os.Stderr, "API key (not shown): ")
	echo := func(flag string) {
		stty := exec.Command("stty", flag)
		stty.Stdin = os.Stdin
		_ = stty.Run()
	}
	echo("-echo")
	defer func() {
		echo("echo")
		fmt.Fprintln(os.Stderr)
	}()
	return bufio.NewReader(os.Stdin).ReadString('\n')
}

// checkNow has the model proxy check the harness's key at once (K10): its state after; false when the proxy does not run.
func checkNow(at paths.Paths, harness string) (keys.StateAt, bool) {
	address, ok := modelproxy.Runtime{Folder: at.Proxy}.URL()
	if !ok {
		return keys.StateAt{}, false
	}
	client := http.Client{Timeout: time.Minute}
	answer, err := client.Post(address+modelproxy.CheckPath+harness, "application/json", nil)
	if err != nil {
		return keys.StateAt{}, false
	}
	defer answer.Body.Close()
	var key keys.StateAt
	if answer.StatusCode != http.StatusOK || json.NewDecoder(answer.Body).Decode(&key) != nil || key.State == "" {
		return keys.StateAt{}, false
	}
	return key, true
}

// passEvery is how often the loop runs a pass: restarts and releases wait at most this long.
const passEvery = 5 * time.Second

// stdout and stderr are the process's own, capped where launchd writes them to the log file; the journal caps itself.
var (
	stdout io.Writer = os.Stdout
	stderr io.Writer = os.Stderr
)

func capLog(logs string) {
	file := filepath.Join(logs, "trierarch.log")
	if logfile.IsWritingTo(os.Stdout, file) {
		stdout = logfile.Capped{File: file, Out: os.Stdout, Now: time.Now}
	}
	if logfile.IsWritingTo(os.Stderr, file) {
		stderr = logfile.Capped{File: file, Out: os.Stderr, Now: time.Now}
	}
}

func logLine(line string) {
	fmt.Fprintf(stderr, "%s %s\n", time.Now().UTC().Format(time.RFC3339), line)
}

// sessionRuntime is the host session runtime: each session under a hold, the trierarch program run as `hold`, in a systemd scope of its own under the service.
func sessionRuntime(at paths.Paths, program string) sessions.Runtime {
	return sessions.Runtime{Sessions: at.Sessions, Program: []string{program}, Version: cli.Version, Launch: sessions.Launch(runtime.GOOS, os.Getenv("INVOCATION_ID"), sessions.SystemdVersion()), BootedAt: sessions.BootedAt}
}

func environment() map[string]string {
	env := map[string]string{}
	for _, entry := range os.Environ() {
		if name, value, ok := strings.Cut(entry, "="); ok {
			env[name] = value
		}
	}
	return env
}

// newPass is one pass of the run loop with this machine's adapters: the fleet over /api/v1 with the trierarch's crew token, the harnesses the configuration offers, worktrees of the configured repositories, and the state file.
func newPass(at paths.Paths, kept crew.File, configuration config.Configuration, home string, program string) (func(isKeyCutOff bool) error, error) {
	env := environment()
	client := fleet.Client{URL: kept.FleetURL, CrewToken: kept.CrewToken, Model: "@aeolus-fleet/trierarch@" + cli.Version}
	// Detected again only for a harness whose version changed since (#365); the operator's own options win.
	detect := detectionOf(at, env, home, logLine)
	detected, err := detect.Detect(context.Background(), slices.Sorted(maps.Keys(configuration.Harnesses)), detection.ByStart)
	if err != nil {
		return nil, err
	}
	tellDetectionProblems(client, detected)
	for _, harness := range detection.ModelOptionsIgnored(configuration) {
		logLine(harness + ": the configuration's model option is ignored: model ids come from detection only (#382); remove it")
	}
	offers := &offers{configured: configuration, detected: detected}
	configured := configuration
	configuration = detection.Offered(configuration, detected)
	// The trusted repositories the trierarch plugin sent last change while the trierarch runs: each pass and report reads them afresh (aeolus-fleet#384).
	held := trustedRepositories(at, configured, home)
	withTrusted := func(base config.Configuration) config.Configuration {
		return trusted.WithRepositories(base, held.Current(), held.CloneOf)
	}
	clones := trusted.Clones{Root: at.Repositories, URLOf: func(name string) string {
		if _, isConfigured := configured.Repositories[name]; isConfigured {
			return ""
		}
		for _, repository := range held.Current() {
			if repository.Name == name {
				return repository.URL
			}
		}
		return ""
	}}
	ask := &trusted.Ask{Fleet: client, PluginShipID: kept.PluginShipID, Log: logLine}
	running := sessionRuntime(at, program)
	proxy := modelProxy(at, program)
	harnesses, offeredHarnesses, err := harnessesOf(configuration, at, env, home, running, proxy, offers)
	if err != nil {
		return nil, err
	}
	root := configuration.WorktreeRoot
	if root == "" {
		root = at.Worktrees
	}
	// The places a pass makes workspaces in and offers: the configured ones and the trusted repositories beside them.
	placesOf := func() (workspace.Places, []string, []string) {
		offered := withTrusted(configuration)
		places := workspace.Places{Root: root, Repositories: map[string]string{}, Folders: map[string]string{}, Clone: clones.WhenMissing, ClonedPath: clones.ClonedPath}
		repositories, folders := []string{}, []string{}
		for name, repository := range offered.Repositories {
			places.Repositories[name] = repository.Path
			repositories = append(repositories, name)
		}
		for name, folder := range offered.Folders {
			places.Folders[name] = folder.Path
			folders = append(folders, name)
		}
		return places, repositories, folders
	}
	places, repositories, folders := placesOf()
	logins := keys.Logins{Configured: configuration.Logins, States: keys.States{Keys: at.Keys, File: modelproxy.FilesOf(at.Proxy).KeyStates}, Subscriptions: map[string]keys.Subscription{
		// What each harness reads itself, checked before a session starts on its subscription (api keys K6).
		"claude-code": claudecode.Subscription{Settings: configuration.Harnesses["claude-code"], Managed: claudecode.ManagedSettings(), User: claudecode.UserSettings(home, env["CLAUDE_CONFIG_DIR"])},
		"codex":       codex.Subscription{},
	}}
	// Read-only checkouts only of the configured repositories, never the trusted ones beside them (docs/trierarch.md, "Read-only checkouts").
	checked := checkouts.Git{Root: at.Checkouts, Repositories: configured.Repositories}
	opened = shipSockets(at, kept.FleetURL, running, checked)
	load := &machineload.Reader{Source: machineload.System{WorktreeRoot: root}, Now: time.Now, Log: logLine}
	saved := state.File{Path: at.State}
	pass := runpass.Pass{
		Fleet:           client,
		Sessions:        running,
		Harnesses:       harnesses,
		Workspace:       places,
		FolderProcesses: folderprocess.Stopper{},
		Checkouts:       checked,
		Store:           saved,
		Log:             logLine,
		Now:             time.Now,
		NewLaunchID:     newLaunchID,
		FleetURL:        kept.FleetURL,
		Sockets:         opened,
		Offered:         offeredHarnesses,
		Repositories:    repositories,
		Folders:         folders,
		RunningCap:      configuration.Caps.Running,
		Logins:          logins,
		// The model proxy runs while any harness holds an API key (headless H16); a pass starts it again when it is gone.
		Proxy: proxy,
		Keys:  keys.Files{Folder: at.Keys},
		// A harness's version as detection found it, for the notice of a refused model.
		VersionOf: offers.version,
		// What the machine offers changes while it runs, as sessions refuse models (#382): each pass reads it afresh.
		Offers: offers.options,
		RefuseModel: func(harness string, model string) error {
			return detect.Refuse(context.Background(), harness, model, time.Now(), offers.set)
		},
		// The machine's memory and disk, read each minute; argo is told once when one is low (#400).
		Load: load,
	}
	// What each harness trusts is read from its own files at each report (#381).
	trustReaders := map[string]func() map[string]bool{
		"claude-code": claudecode.Of(home, env["CLAUDE_CONFIG_DIR"]).TrustedFolders,
		"codex":       func() map[string]bool { return codex.TrustedFolders(codex.HomeOf(home, env["CODEX_HOME"])) },
		"copilot":     func() map[string]bool { return trust.Everything(withTrusted(configuration))() },
	}
	// The harnesses as offered now, and what each trusts and still asks to accept, are read at each pass (#381, #403).
	pass.Configuration = func() map[string]config.Harness {
		offered, _ := offers.current()
		return offered.Harnesses
	}
	pass.Trusted = func() map[string]reconciler.Trust {
		offered, _ := offers.current()
		trusted := map[string]reconciler.Trust{}
		for harness, places := range trust.Of(withTrusted(offered), trustReaders) {
			trusted[harness] = reconciler.Trust{Repositories: places.Repositories, Folders: places.Folders}
		}
		if claudeCode, ok := trusted["claude-code"]; ok && !claudecode.IsSkipPermissionsAccepted(claudecode.UserSettings(home, env["CLAUDE_CONFIG_DIR"])) {
			claudeCode.UnacceptedFlags = []string{"--dangerously-skip-permissions"}
			trusted["claude-code"] = claudeCode
		}
		return trusted
	}

	read := usageOf(configured, env, home, pass.Store)
	// The usage goes to the trierarch plugin's ship once an hour, and a released ship's last usage before its folder goes.
	sender := &usage.Sender{Harnesses: read.Harnesses, Reader: read, MadeAt: usage.FolderMadeAt, Store: saved, Fleet: client, Prices: read.Prices, Now: time.Now, Log: logLine, TrierarchShipID: kept.ShipID, PluginShipID: kept.PluginShipID}
	pass.SendReleasedUsage = sender.SendReleased
	reporter := &selfreport.Reporter{
		Fleet:    client,
		Store:    pass.Store,
		Sessions: running,
		// The pass reads the load first; the report takes the one it read.
		Load: load,
		// The harnesses' usage, each part read on its own interval (#353).
		Usage: read,
		Input: func() selfreport.Input {
			offered, detected := offers.current()
			offered = withTrusted(offered)
			return selfreport.Input{Configuration: offered, Detected: detected, Harnesses: offeredHarnesses, Trusted: trust.Of(offered, trustReaders), Logins: logins, Version: cli.Version, OS: runtime.GOOS, Arch: runtime.GOARCH}
		},
	}
	// Each pass ends with the trierarch's own report: the first at start, then only when it changed.
	return func(isKeyCutOff bool) error {
		ask.Once()
		current := pass
		current.Workspace, current.Repositories, current.Folders = placesOf()
		if err := current.Run(); err != nil {
			return err
		}
		if err := reporter.Report(isKeyCutOff); err != nil {
			return err
		}
		return sender.Send()
	}, nil
}

// usageOf reads the usage of the configured harnesses: Claude Code's from its projects folder and a short turn, Codex's from its session logs in CODEX_HOME, or in ~/.codex.
func usageOf(configured config.Configuration, env map[string]string, home string, store usage.Store) *usage.Reader {
	return &usage.Reader{
		Harnesses: map[string]usage.Harness{
			"claude-code": &claudecode.Usage{Projects: claudecode.Projects(home, env["CLAUDE_CONFIG_DIR"]), MadeAt: usage.FolderMadeAt, Run: detection.Run, NeutralFolder: detection.NeutralFolder},
			"codex":       &codex.Usage{Sessions: filepath.Join(codex.HomeOf(home, env["CODEX_HOME"]), "sessions"), MadeAt: usage.FolderMadeAt},
		},
		// Each configured harness's subscription, in the adapters' order, the order init writes them in.
		Configured: slices.DeleteFunc(slices.Clone(adapters), func(name string) bool {
			_, ok := configured.Harnesses[name]
			return !ok
		}),
		Store:  store,
		Prices: usage.PricesOf(configured.Prices),
		Now:    time.Now,
		Log:    logLine,
	}
}

// detectionOf is detection of this machine's harnesses, kept in detected.json, telling the operator what it kept as before with warn.
func detectionOf(at paths.Paths, env map[string]string, home string, warn func(line string)) detection.Detection {
	// Codex's and Copilot's own files, in CODEX_HOME and COPILOT_HOME when set (#521).
	codexHome, copilotHome := env["CODEX_HOME"], env["COPILOT_HOME"]
	if codexHome == "" {
		codexHome = filepath.Join(home, ".codex")
	}
	if copilotHome == "" {
		copilotHome = filepath.Join(home, ".copilot")
	}
	return detection.Detection{
		Detectors: map[string]detection.Detector{
			"claude-code": claudecode.Detector{Run: detection.Run, NeutralFolder: detection.NeutralFolder},
			"codex":       codex.Detector{Run: detection.Run, ReadConfig: textOf(filepath.Join(codexHome, "config.toml")), NeutralFolder: detection.NeutralFolder},
			"copilot":     copilot.Detector{Run: detection.Run, ReadSettings: textOf(filepath.Join(copilotHome, "settings.json"))},
		},
		Store: detection.File{Path: at.Detected},
		Now:   time.Now,
		Warn:  warn,
	}
}

// textOf reads the file each time it is asked; empty when there is none.
func textOf(path string) func() string {
	return func() string {
		text, _ := os.ReadFile(path)
		return string(text)
	}
}

// tellDetectionProblems tells argo what detection could not find, once per harness version: the idempotency key names both, so the fleet keeps it once however often the trierarch starts.
func tellDetectionProblems(client fleet.Client, detected detection.Detected) {
	for _, harness := range slices.Sorted(maps.Keys(detected)) {
		found := detected[harness]
		if found.Problem == "" {
			continue
		}
		if err := client.ReportToArgo(notices.DetectionProblem(harness, found.Version, found.Problem), fmt.Sprintf("trierarch:detection:%s:%s", harness, found.Version)); err != nil {
			logLine("Could not tell argo what detection found: " + err.Error())
		}
	}
}

// offers are what the configured harnesses offer as detected, changed while the trierarch runs as sessions refuse models (#382), and read by each pass.
type offers struct {
	configured config.Configuration
	mu         sync.Mutex
	detected   detection.Detected
}

func (o *offers) set(detected detection.Detected) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.detected = detected
}

// current is the configuration as offered now, with what detection found.
func (o *offers) current() (config.Configuration, detection.Detected) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return detection.Offered(o.configured, o.detected), o.detected
}

// version is the harness's version as detection found it; empty when it found none.
func (o *offers) version(harness string) string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.detected[harness].Version
}

// permissionModes are the permission modes the harness lists as detection found them; none when it found none.
func (o *offers) permissionModes(harness string) []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.detected[harness].PermissionModes
}

// options are, by harness, each option it offers now and its value names in order.
func (o *offers) options() map[string]map[string][]string {
	o.mu.Lock()
	offered := detection.Offered(o.configured, o.detected)
	o.mu.Unlock()
	options := map[string]map[string][]string{}
	for harness, settings := range offered.Harnesses {
		options[harness] = map[string][]string{}
		for name, option := range settings.Options {
			options[harness][name] = option.Names()
		}
	}
	return options
}

// adapters are the harnesses this trierarch has an adapter for, the default first.
var adapters = []string{"claude-code", "codex", "copilot"}

// harnessesOf are the adapters of the harnesses the configuration offers, each with the aeolus-fleet plugin its harness installed, and their names, the default first. Claude Code's and Codex's plugin is looked for at start, so a trierarch without it does not start; Copilot's at each crew, so the machine offers Copilot once it is installed. A configured harness this trierarch has no adapter for stops it at start, so no request for it is ever crewed.
func harnessesOf(configuration config.Configuration, at paths.Paths, env map[string]string, home string, running sessions.Runtime, proxy modelproxy.Runtime, offers *offers) (map[string]runpass.Harness, []string, error) {
	for name := range configuration.Harnesses {
		if !slices.Contains(adapters, name) {
			return nil, nil, fmt.Errorf("this trierarch has no adapter for the harness %s: it offers %s", name, strings.Join(adapters, ", "))
		}
	}
	events := func(shipID string) string { return hold.FilesOf(at.Sessions, shipID).Events }
	harnesses := map[string]runpass.Harness{}
	offered := []string{}
	for _, name := range adapters {
		settings, ok := configuration.Harnesses[name]
		if !ok {
			continue
		}
		switch name {
		case "claude-code":
			found, err := plugin.Find(home, env)
			if err != nil {
				return nil, nil, err
			}
			harnesses[name] = claudecode.Harness{
				Plugin:     found,
				Runtime:    running,
				Settings:   settings,
				Projects:   claudecode.Projects(home, env["CLAUDE_CONFIG_DIR"]),
				Onboarding: claudecode.Of(home, env["CLAUDE_CONFIG_DIR"]),
				Managed:    claudecode.ManagedSettings(),
				User:       claudecode.UserSettings(home, env["CLAUDE_CONFIG_DIR"]),
				// As detection last found them: none before it found any.
				PermissionModes: func() []string { return offers.permissionModes("claude-code") },
				Events:          events,
				ProxyURL:        proxy.URL,
			}
		case "codex":
			found, err := plugin.FindCodex(home, env)
			if err != nil {
				return nil, nil, err
			}
			harnesses[name] = codex.Harness{Plugin: found, Runtime: running, Settings: settings, Hooks: codex.AppServer{Program: "codex", Version: cli.Version}, Events: events, ProxyURL: proxy.URL}
		case "copilot":
			harnesses[name] = copilot.Harness{Plugin: plugin.FindCopilot(home, env), Runtime: running, Settings: settings, Events: events, Version: func() (string, bool) {
				// As detection last found it: a Copilot not detected yet is not offered.
				version := offers.version("copilot")
				return version, version != ""
			}, CopilotHome: env["COPILOT_HOME"]}
		}
		offered = append(offered, name)
	}
	return harnesses, offered, nil
}

// newLaunchID is a launch id of its own, a random UUID.
func newLaunchID() string {
	bytes := make([]byte, 16)
	_, _ = rand.Read(bytes)
	bytes[6], bytes[8] = bytes[6]&0x0f|0x40, bytes[8]&0x3f|0x80
	text := hex.EncodeToString(bytes)
	return text[0:8] + "-" + text[8:12] + "-" + text[12:16] + "-" + text[16:20] + "-" + text[20:]
}

// systemctl runs systemctl with what it needs to reach the user's bus: XDG_RUNTIME_DIR, or /run/user/<uid> where the shell has none.
func systemctl(name string, args ...string) (string, error) {
	if os.Getenv("XDG_RUNTIME_DIR") == "" {
		if err := os.Setenv("XDG_RUNTIME_DIR", "/run/user/"+strconv.Itoa(os.Getuid())); err != nil {
			return "", err
		}
	}
	return service.Run(name, args...)
}

// isTerminal says whether the file is a terminal, as Node's isTTY does: the null device is a character device, no terminal.
func isTerminal(file *os.File) bool {
	return term.IsTerminal(int(file.Fd()))
}

// startedAt is when the process started, as ps says how long it runs; empty when ps cannot tell.
func startedAt(pid int) string {
	output, err := exec.Command("ps", "-o", "etime=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return cli.StartedAtFrom(string(output), time.Now())
}
