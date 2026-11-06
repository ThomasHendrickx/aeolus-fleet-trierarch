package container

import (
	"fmt"
	"maps"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

const (
	prefix     = "trierarch-"
	ownerLabel = "aeolus.trierarch"
	// owner tells this trierarch's containers apart from any other on the machine.
	owner = "aeolus-trierarch"
	// ModelTokenVariable is the variable Claude Code reads its long-lived model token from (`claude setup-token`).
	ModelTokenVariable = "CLAUDE_CODE_OAUTH_TOKEN"
	// SessionHome is the session user's home in the image, where each container gets its ship's own home.
	SessionHome = "/home/ubuntu"
	// sessionUser is the image's session user (ubuntu), whose subordinate ids the nested Podman maps.
	sessionUser = "uid=1000,gid=1000"
	// pidsLimit is the most processes and threads a container may hold, a hard cap beside memory and cpus (decision 0039): room for Claude Code, a test run with its workers, a browser and a nested Postgres, and none for a runaway fork.
	pidsLimit = 4096
	// proxyHost is the container's loopback, where pasta forwards only the proxy port.
	proxyHost = "127.0.0.1"

	// envFile is the env file in the session's own folder, beside its hold's files.
	envFile = "session.env"
)

var shipIDPattern = regexp.MustCompile(`^shp_[0-7][0-9a-hjkmnp-tv-z]{25}$`)

// ProxyURL is where a session in a container reaches the model proxy the trierarch reaches at the url, on the host's loopback.
func ProxyURL(address string) string {
	at, err := url.Parse(address)
	if err != nil {
		return address
	}
	if port := at.Port(); port != "" {
		at.Host = proxyHost + ":" + port
	} else {
		at.Host = proxyHost
	}
	return at.Scheme + "://" + at.Host
}

// Runtime is the container session runtime (decision 0039, headless H18): one
// container per ship, named after its ship id, run by the ship's hold on the
// host as `run --rm -i`, attached, so a line sent, an interrupt and the events
// are the hold's, as on the host, and the container lives as long as the
// hold. Rootless only, with hard memory and cpu caps and no restart policy:
// the trierarch starts a dead session again itself. The container sees its
// folder, its ship's own home as its home, its ship's socket folder and its
// read-only checkouts, at their own paths, and nothing else of the host,
// never the runtime's socket.
//
// The model token and the session's environment reach the container through
// an env file in the session's own folder, for its owner alone, never a
// command line. A session on an API key gets no model token: its proxy token,
// which its hold holds in the environment it runs the container with, is
// passed on by its variable's name alone. Only the proxy's TCP port is
// forwarded from container loopback to host loopback (headless H16, api keys K7).
type Runtime struct {
	// Holds are the holds that run the containers.
	Holds sessions.Runtime
	// Binary is the docker-style binary of a rootless runtime: podman on Linux, docker in a Colima context on macOS.
	Binary string
	Image  string
	// ModelToken is the file holding the machine's long-lived model token, read at every start.
	ModelToken string
	// ProxyURL is the host proxy listener, read when a session starts.
	ProxyURL func() (string, bool)
	// Homes is where the ships' homes are kept on the host, one folder per ship, each mounted as its container's home.
	Homes string
	// Sockets is where the ships' sockets are kept on the host, one folder per ship, each mounted at its own path (decision 0026).
	Sockets string
	// Memory is the memory cap of each container, as the runtime takes it (`4g`).
	Memory string
	Cpus   float64
	// Run runs the binary with the words and answers its stdout; the binary itself when nil.
	Run func(args ...string) (string, error)
}

func containerName(shipID string) string { return prefix + shipID }

// HomeOf is the ship's own home under the homes folder.
func HomeOf(homes string, shipID string) string { return filepath.Join(homes, shipID) }

func (r Runtime) run(args ...string) (string, error) {
	if r.Run != nil {
		return r.Run(args...)
	}
	said, err := exec.Command(r.Binary, args...).Output()
	if err != nil {
		return "", fmt.Errorf("%s %s failed: %w", r.Binary, args[0], err)
	}
	return string(said), nil
}

func (r Runtime) holds() sessions.Runtime {
	holds := r.Holds
	holds.HeldAs = r.heldAs
	return holds
}

// stopContainer kills, then removes the ship's container: a remove alone waits out the stop timeout on podman. One that is not there is no matter.
func (r Runtime) stopContainer(shipID string) {
	_, _ = r.run("kill", containerName(shipID))
	_, _ = r.run("rm", "--force", containerName(shipID))
}

// Start starts the ship's session in a container its hold runs, its last container and hold stopped first.
func (r Runtime) Start(session sessions.Start) error {
	r.stopContainer(session.ShipID)
	return r.holds().Start(session)
}

// Stop stops the ship's container, then its hold, which ends with it.
func (r Runtime) Stop(shipID string) error {
	r.stopContainer(shipID)
	return r.Holds.Stop(shipID)
}

func (r Runtime) Send(shipID string, line string) error { return r.Holds.Send(shipID, line) }

func (r Runtime) Interrupt(shipID string) error { return r.Holds.Interrupt(shipID) }

// List is every ship's session its hold says, and a container no hold holds as of another version: an older trierarch started it (H19).
func (r Runtime) List() ([]sessions.Observed, error) {
	held, err := r.Holds.List()
	if err != nil {
		return nil, err
	}
	listed, err := r.run("ps", "--all", "--filter", "label="+ownerLabel+"="+owner, "--format", "{{.Names}} {{.State}}")
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(listed, "\n") {
		name, state, _ := strings.Cut(strings.TrimSpace(line), " ")
		shipID, isOurs := strings.CutPrefix(name, prefix)
		if !isOurs || !shipIDPattern.MatchString(shipID) || slices.ContainsFunc(held, func(session sessions.Observed) bool { return session.ShipID == shipID }) {
			continue
		}
		status := "exited"
		if state == "running" {
			status = "running"
		}
		held = append(held, sessions.Observed{ShipID: shipID, Status: status, IsOtherVersion: true})
	}
	return held, nil
}

// Root is the container's first process as the host sees it: every process of the session runs under it; 0 once it runs no more.
func (r Runtime) Root(shipID string) int {
	inspected, err := r.run("inspect", "--format", "{{.State.Pid}}", containerName(shipID))
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(inspected))
	if err != nil || pid <= 1 {
		return 0
	}
	return pid
}

// heldAs is the runtime's run of the session, for its hold to run: its env file written, and the folders the runtime mounts made, since it mounts only a folder that exists.
func (r Runtime) heldAs(session sessions.Start, files hold.Files) (sessions.Start, error) {
	env := map[string]string{}
	for name, value := range session.Env {
		env[name] = value
	}
	if session.ProxyToken == nil {
		token, err := os.ReadFile(r.ModelToken)
		if err != nil {
			return sessions.Start{}, fmt.Errorf("read the model token: %w", err)
		}
		env[ModelTokenVariable] = strings.TrimSpace(string(token))
	}
	var content strings.Builder
	for _, name := range slices.Sorted(maps.Keys(env)) {
		if strings.Contains(env[name], "\n") {
			return sessions.Start{}, fmt.Errorf("the environment value of %s spans more than one line, which an env file cannot hold", name)
		}
		content.WriteString(name + "=" + env[name] + "\n")
	}
	home := HomeOf(r.Homes, session.ShipID)
	sockets := filepath.Join(r.Sockets, session.ShipID)
	for _, folder := range []string{sockets, home} {
		if err := os.MkdirAll(folder, 0o700); err != nil {
			return sessions.Start{}, err
		}
	}
	file := filepath.Join(files.Folder, envFile)
	if err := os.WriteFile(file, []byte(content.String()), 0o600); err != nil {
		return sessions.Start{}, err
	}
	folder := session.Folder
	command := []string{
		r.Binary, "run", "--rm", "-i",
		"--name", containerName(session.ShipID),
		"--label", ownerLabel + "=" + owner,
		// Without it, podman lets swap double the memory cap.
		"--memory-swap", r.Memory,
		"--memory", r.Memory,
		"--cpus", strconv.FormatFloat(r.Cpus, 'f', -1, 64),
		"--pids-limit", strconv.Itoa(pidsLimit),
		"--userns=keep-id:" + sessionUser,
		"--device", "/dev/fuse",
		"--device", "/dev/net/tun",
		"--cap-add", "SYS_ADMIN",
		"--security-opt", "unmask=ALL",
		"--volume", folder + ":" + folder,
		"--volume", home + ":" + SessionHome,
		// The session calls the fleet over its ship's socket, at the path its identity names.
		"--volume", sockets + ":" + sockets,
	}
	// Its read-only checkouts, at their own paths as its identity names them: read-only in the mount, which the session cannot undo.
	for _, path := range session.ReadOnly {
		command = append(command, "--volume", path+":"+path+":ro")
	}
	command = append(command, "--env", "HOME="+SessionHome)
	if session.ProxyToken != nil {
		command = append(command, "--env", session.ProxyToken.Variable)
	}
	// The model proxy and the MCP proxy listen on the host's loopback.
	if session.ProxyToken != nil || session.Mcp != nil {
		if r.ProxyURL == nil {
			return sessions.Start{}, fmt.Errorf("the proxy address is unavailable")
		}
		address, ok := r.ProxyURL()
		at, err := url.Parse(address)
		if !ok || err != nil || at.Port() == "" {
			return sessions.Start{}, fmt.Errorf("the proxy port is unavailable")
		}
		port, err := strconv.Atoi(at.Port())
		if err != nil || port < 1 || port > 65535 {
			return sessions.Start{}, fmt.Errorf("the proxy port is invalid")
		}
		// No gateway mapping or automatic forwarding: only this TCP port on
		// the container's loopback reaches the host's loopback listener.
		command = append(command, "--network", "pasta:--no-map-gw,-t,none,-u,none,-T,"+strconv.Itoa(port)+",-U,none")
	}
	command = append(command, "--workdir", folder, "--env-file", file, r.Image)
	session.Command = append(command, session.Command...)
	// The session's environment reaches the container through the env file alone.
	session.Env = map[string]string{}
	return session, nil
}
