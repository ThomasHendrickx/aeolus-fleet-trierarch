// Command aeolus-trierarch is the Go trierarch (docs/design/trierarch-binary.md):
// one binary with no Node, built beside today's trierarch part by part
// against the contract suite. See internal/cli for its commands.
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/claudecode"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/cli"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/fleet"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/keys"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/modelproxy"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/peer"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/runpass"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/service"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/shipsocket"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/state"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/workspace"
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
	machine := cli.Machine{
		Environ:               environ,
		HomeDirectory:         home,
		Platform:              runtime.GOOS,
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
		Service: func(at paths.Paths) cli.ServiceManager {
			return service.Systemd{HomeDirectory: home, Logs: at.Logs, Program: program, Environment: service.Environment(environ), Exec: systemctl}
		},
		Register:    fleet.Register,
		IsLeaseHeld: fleet.IsLeaseHeld,
		Sleep:       func() { time.Sleep(time.Second) },
		Stop:        stop,
		CoreVersionRefusal: func(fleetURL string) string {
			return fleet.CoreVersionRefusal(fleetURL, cli.Version, fleet.MinimumCoreVersion)
		},
		NewPass: func(at paths.Paths, kept crew.File, configuration config.Configuration) (func() error, error) {
			return newPass(at, kept, configuration, home, program)
		},
		PassEvery: passEvery,
		Sessions:  func(at paths.Paths) cli.Sessions { return sessionRuntime(at, program) },
		Log:       logLine,
		ReadKey:   readKey,
		CheckKey: func(harness string, key string) keys.Checked {
			return keys.Check(harness, key, "")
		},
		CheckNow: checkNow,
	}
	output, code := cli.Main(os.Args[1:], machine)
	// While the trierarch is down a session's call gets no answer, as when the fleet is down (decision 0026).
	if opened != nil {
		opened.CloseAll()
	}
	if output != "" {
		fmt.Println(output)
	}
	os.Exit(code)
}

// opened are the ships' sockets run opened, closed once it ends.
var opened *shipsocket.Sockets

// shipSockets are each ship's socket for its session's fleet calls, with its crew token from the state at each call (decision 0026). A caller is allowed only under the ship's own hold, or under the trierarch itself, as its aeolus-push.sh.
func shipSockets(at paths.Paths, fleetURL string, running sessions.Runtime) *shipsocket.Sockets {
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
		Log: logLine,
	})
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

func logLine(line string) {
	fmt.Fprintf(os.Stderr, "%s %s\n", time.Now().UTC().Format(time.RFC3339), line)
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

// newPass is one pass of the run loop with this machine's adapters: the fleet over /api/v1 with the trierarch's crew token, Claude Code as the one harness, worktrees of the configured repositories, and the state file.
func newPass(at paths.Paths, kept crew.File, configuration config.Configuration, home string, program string) (func() error, error) {
	env := environment()
	running := sessionRuntime(at, program)
	proxy := modelProxy(at, program)
	harnesses := map[string]runpass.Harness{}
	offered := []string{}
	if settings, ok := configuration.Harnesses["claude-code"]; ok {
		found, err := plugin.Find(home, env)
		if err != nil {
			return nil, err
		}
		harnesses["claude-code"] = claudecode.Harness{
			Plugin:     found,
			Runtime:    running,
			Settings:   settings,
			Projects:   claudecode.Projects(home, env["CLAUDE_CONFIG_DIR"]),
			Onboarding: claudecode.Of(home, env["CLAUDE_CONFIG_DIR"]),
			Events:     func(shipID string) string { return hold.FilesOf(at.Sessions, shipID).Events },
			ProxyURL:   proxy.URL,
		}
		offered = append(offered, "claude-code")
	}
	root := configuration.WorktreeRoot
	if root == "" {
		root = at.Worktrees
	}
	places := workspace.Places{Root: root, Repositories: map[string]string{}, Folders: map[string]string{}}
	repositories, folders := []string{}, []string{}
	for name, repository := range configuration.Repositories {
		places.Repositories[name] = repository.Path
		repositories = append(repositories, name)
	}
	for name, folder := range configuration.Folders {
		places.Folders[name] = folder.Path
		folders = append(folders, name)
	}
	opened = shipSockets(at, kept.FleetURL, running)
	pass := runpass.Pass{
		Fleet:        fleet.Client{URL: kept.FleetURL, CrewToken: kept.CrewToken},
		Sessions:     running,
		Harnesses:    harnesses,
		Workspace:    places,
		Store:        state.File{Path: at.State},
		Log:          logLine,
		Now:          time.Now,
		NewLaunchID:  newLaunchID,
		FleetURL:     kept.FleetURL,
		Sockets:      opened,
		Offered:      offered,
		Repositories: repositories,
		Folders:      folders,
		RunningCap:   configuration.Caps.Running,
		Logins:       keys.Logins{Configured: configuration.Logins, States: keys.States{Keys: at.Keys, File: modelproxy.FilesOf(at.Proxy).KeyStates}},
		// The model proxy runs while any harness holds an API key (headless H16); a pass starts it again when it is gone.
		Proxy: proxy,
		Keys:  keys.Files{Folder: at.Keys},
	}
	return pass.Run, nil
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
