package modelproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/keys"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpproxy"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpservers"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/secrets"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/processproof"
)

const (
	stateTimeout = 2 * time.Second
	startWait    = 10 * time.Second
	poll         = 50 * time.Millisecond
	stopWait     = 5 * time.Second
	loopback     = "127.0.0.1"
)

// detached runs the command in the background and returns at once, as a hold's start does: its process is then nobody's child.
const detached = `"$@" < /dev/null > /dev/null 2>&1 &`

// Files are the proxy's files in its folder: its pid, the port it listens on, and each harness's key state.
type Files struct {
	PID       string
	Port      string
	KeyStates string
}

// FilesOf the proxy's folder.
func FilesOf(folder string) Files {
	return Files{PID: filepath.Join(folder, "proxy.pid"), Port: filepath.Join(folder, "port"), KeyStates: filepath.Join(folder, "key-states.json")}
}

// Runtime keeps the model proxy running while a harness needs it (headless H16): one per machine, started like a hold, nobody's child and under a systemd unit in a scope of its own, so a restart of the service ends no session's way to its vendor.
type Runtime struct {
	Folder   string
	Sessions string
	Keys     string
	// McpServers is the MCP servers file, which the proxy reads at each request to an MCP server.
	McpServers string
	// Secrets is the secrets file, which the proxy reads at each request to an MCP server that needs a credential.
	Secrets string
	// Program is the trierarch program, which `proxy` and its words follow.
	Program []string
	Version string
	// Launch is what the proxy's start goes through, as a hold's start does (see sessions.Launch).
	Launch []string
}

// URL is where sessions reach the proxy; false before it first listened.
func (r Runtime) URL() (string, bool) {
	text, err := os.ReadFile(FilesOf(r.Folder).Port)
	if err != nil {
		return "", false
	}
	port, err := strconv.Atoi(strings.TrimSpace(string(text)))
	if err != nil || port <= 0 {
		return "", false
	}
	return "http://" + net.JoinHostPort(loopback, strconv.Itoa(port)), true
}

// answeredVersion is the version the proxy at its address answers; empty when nothing answers.
func (r Runtime) answeredVersion() string {
	address, ok := r.URL()
	if !ok {
		return ""
	}
	client := http.Client{Timeout: stateTimeout}
	answer, err := client.Get(address + StatePath)
	if err != nil {
		return ""
	}
	defer answer.Body.Close()
	var state struct {
		Version string `json:"version"`
	}
	if answer.StatusCode != http.StatusOK || json.NewDecoder(answer.Body).Decode(&state) != nil {
		return ""
	}
	return state.Version
}

// runningPID is the proxy's pid while its process runs, 0 otherwise: a pid file's pid that is not this proxy by its command line is nobody to signal.
func (r Runtime) runningPID() int {
	text, err := os.ReadFile(FilesOf(r.Folder).PID)
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(text)))
	if err != nil || pid <= 1 || syscall.Kill(pid, 0) != nil || !processproof.Runs(pid, "proxy", "--folder", r.Folder) {
		return 0
	}
	return pid
}

func (r Runtime) stop() error {
	if pid := r.runningPID(); pid != 0 {
		_ = syscall.Kill(pid, syscall.SIGTERM)
		until := time.Now().Add(stopWait)
		for r.runningPID() != 0 && time.Now().Before(until) {
			time.Sleep(poll)
		}
		if r.runningPID() != 0 {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	err := os.Remove(FilesOf(r.Folder).PID)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (r Runtime) start() error {
	words := append(append([]string{}, r.Program...), "proxy", "--folder", r.Folder, "--sessions", r.Sessions, "--keys", r.Keys, "--mcp-servers", r.McpServers, "--secrets", r.Secrets)
	line := append(append(append([]string{}, r.Launch...), "sh", "-c", detached, "sh"), words...)
	starter := exec.Command(line[0], line[1:]...)
	starter.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if wrote, err := starter.CombinedOutput(); err != nil {
		return fmt.Errorf("the model proxy did not start: %s ended with %v: %s", line[0], err, strings.TrimSpace(string(wrote)))
	}
	until := time.Now().Add(startWait)
	for time.Now().Before(until) {
		if r.runningPID() != 0 && r.answeredVersion() != "" {
			return nil
		}
		time.Sleep(poll)
	}
	return fmt.Errorf("the model proxy did not answer within %s of its start", startWait)
}

// Keep runs the proxy while it is needed: one that is gone is started again on its port, one another version started is replaced, and one no harness needs is stopped.
func (r Runtime) Keep(isNeeded bool) error {
	if !isNeeded {
		return r.stop()
	}
	if r.answeredVersion() == r.Version {
		return nil
	}
	// Its pid file goes before the start, so the wait sees the new proxy's.
	if err := r.stop(); err != nil {
		return err
	}
	return r.start()
}

const usage = "Usage: aeolus-trierarch proxy --folder <folder> --sessions <folder> --keys <folder> --mcp-servers <file> --secrets <file>"

// Main runs `aeolus-trierarch proxy` with the words after `proxy`, as the trierarch starts it, never a person: the model proxy and the MCP proxy in one process. It listens on loopback, on the port it listened on before when it can, so a running session reaches it where it did; it writes its port and pid in its folder, checks each key out of credit every 15 minutes, and ends on SIGTERM. Answers its exit code, or 2 for words it cannot take.
func Main(words []string, version string) int {
	values := map[string]string{}
	for at := 0; at+1 < len(words); at += 2 {
		values[words[at]] = words[at+1]
	}
	folder, sessions, keysFolder, servers, secretsFile := values["--folder"], values["--sessions"], values["--keys"], values["--mcp-servers"], values["--secrets"]
	if folder == "" || sessions == "" || keysFolder == "" || servers == "" || secretsFile == "" || len(words) != 10 {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	if err := os.MkdirAll(folder, 0o700); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	files := FilesOf(folder)
	before := 0
	if text, err := os.ReadFile(files.Port); err == nil {
		before, _ = strconv.Atoi(strings.TrimSpace(string(text)))
	}
	// The port it had may be taken by now: then any free one, and sessions started from now reach it there.
	listener, err := net.Listen("tcp", net.JoinHostPort(loopback, strconv.Itoa(before)))
	if err != nil {
		listener, err = net.Listen("tcp", net.JoinHostPort(loopback, "0"))
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	proxy := Proxy{Sessions: sessions, Keys: keys.Files{Folder: keysFolder}, States: keys.States{Keys: keysFolder, File: files.KeyStates}, Version: version, Now: time.Now, MCP: mcpproxy.Proxy{Sessions: sessions, Servers: func() []mcpservers.Server {
		// Read at each request: the trierarch keeps the list as it arrives.
		held := mcpservers.File{Path: servers}
		held.Load()
		return held.Current()
	}, Secret: func(name string) (string, bool) {
		// Read at each request too: the trierarch keeps the secrets as they arrive.
		held := secrets.File{Path: secretsFile}
		held.Load()
		return held.Value(name)
	}}}
	server := &http.Server{Handler: proxy, ReadHeaderTimeout: 30 * time.Second}
	port := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
	if err := os.WriteFile(files.Port, []byte(port), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := os.WriteFile(files.PID, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	stopped := make(chan os.Signal, 1)
	signal.Notify(stopped, syscall.SIGTERM, syscall.SIGINT)
	ended := make(chan error, 1)
	go func() { ended <- server.Serve(listener) }()
	// A key out of credit is checked every 15 minutes (K10); a check that fails is tried again at the next.
	checks := time.NewTicker(CheckEvery)
	defer checks.Stop()
	for {
		select {
		case <-checks.C:
			CheckOutOfCredit(proxy)
		case <-stopped:
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_ = server.Shutdown(ctx)
			_ = server.Close()
			return 0
		case err := <-ended:
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
	}
}
