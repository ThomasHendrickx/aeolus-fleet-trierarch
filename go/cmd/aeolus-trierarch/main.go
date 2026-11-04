// Command aeolus-trierarch is the Go trierarch (docs/design/trierarch-binary.md):
// one binary with no Node, built beside today's trierarch part by part
// against the contract suite. See internal/cli for its commands.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/claudecode"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/cli"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/fleet"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/service"
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
	}
	output, code := cli.Main(os.Args[1:], machine)
	if output != "" {
		fmt.Println(output)
	}
	os.Exit(code)
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
