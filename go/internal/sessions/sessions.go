// Package sessions is the host session runtime (headless H4, H8, H9): one
// hold per ship, the trierarch program run as `aeolus-trierarch hold`, which
// runs the harness as its child and holds its input and output. A hold is
// started detached, so it is nobody's child and outlives the trierarch's
// service; under a systemd unit it starts in a scope of its own, so a restart
// of the service ends no session (#479, #537).
//
// A hold that answers runs; one that started since the machine did and no
// longer answers has exited, kept so the exit is seen; one from before the
// machine started is gone.
package sessions

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
)

const (
	// callTimeout is how long a hold has to answer a call.
	callTimeout = 2 * time.Second
	// startWait is how long a hold has to answer its first call after its start.
	startWait = 10 * time.Second
	startPoll = 50 * time.Millisecond
	// stopWait is how long a stopped hold has to end with its harness before it is killed.
	stopWait = 5 * time.Second
)

// detached runs the command in the background and returns at once: its process is then nobody's child.
const detached = `"$@" < /dev/null > /dev/null 2>&1 &`

var shipIDPattern = regexp.MustCompile(`^shp_[0-7][0-9a-hjkmnp-tv-z]{25}$`)

// Observed is a ship's session as its hold says it: running, or exited; of another version when another version of the trierarch started its hold (H19).
type Observed struct {
	ShipID         string
	Status         string
	IsOtherVersion bool
}

// Start is what a session's start is given.
type Start struct {
	ShipID  string
	Folder  string
	Harness string
	Command []string
	// Env is given to the harness on top of the hold's own few variables.
	Env map[string]string
}

type Runtime struct {
	// Sessions is the sessions folder: a folder per ship, with its hold's files.
	Sessions string
	// Program is the trierarch program, which `hold` and its words follow.
	Program []string
	Version string
	// Launch is what a hold's start goes through (see Launch).
	Launch   []string
	BootedAt func() time.Time
}

// Launch is what a session's start goes through on Linux under a systemd unit, which sets INVOCATION_ID: a systemd scope of its own, expanding no variable in the command where systemd-run can be told so (from systemd 254).
func Launch(platform string, invocationID string, systemdVersion int) []string {
	if platform != "linux" || invocationID == "" {
		return nil
	}
	launch := []string{"systemd-run", "--user", "--scope", "--quiet", "--collect"}
	if systemdVersion >= 254 {
		launch = append(launch, "--expand-environment=no")
	}
	return append(launch, "--")
}

// SystemdVersion is the version `systemd-run --version` states, 0 when it states none or cannot run.
func SystemdVersion() int {
	stated, err := exec.Command("systemd-run", "--version").Output()
	if err != nil {
		return 0
	}
	match := regexp.MustCompile(`^systemd (\d+)`).FindSubmatch(stated)
	if match == nil {
		return 0
	}
	version, _ := strconv.Atoi(string(match[1]))
	return version
}

// BootedAt is when the machine started, from /proc/uptime.
func BootedAt() time.Time {
	text, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return time.Time{}
	}
	seconds, err := strconv.ParseFloat(strings.Fields(string(text))[0], 64)
	if err != nil {
		return time.Time{}
	}
	return time.Now().Add(-time.Duration(seconds * float64(time.Second)))
}

// runningPID is the hold's pid while its process runs, 0 otherwise.
func (r Runtime) runningPID(shipID string) int {
	text, err := os.ReadFile(hold.FilesOf(r.Sessions, shipID).PID)
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(text)))
	if err != nil || pid <= 1 || syscall.Kill(pid, 0) != nil {
		return 0
	}
	return pid
}

func (r Runtime) observed(shipID string) (Observed, bool) {
	files := hold.FilesOf(r.Sessions, shipID)
	started, err := os.Stat(files.PID)
	if err != nil || started.ModTime().Before(r.BootedAt()) {
		return Observed{}, false
	}
	answer, err := hold.Call(files.Socket, hold.Request{Call: "state"}, callTimeout)
	if err != nil || !answer.IsOK || answer.State == nil {
		return Observed{ShipID: shipID, Status: "exited"}, true
	}
	return Observed{ShipID: shipID, Status: "running", IsOtherVersion: answer.State.Version != r.Version}, true
}

// Root is the process the ship's session runs under, its hold, while it runs; 0 otherwise.
func (r Runtime) Root(shipID string) int {
	return r.runningPID(shipID)
}

// List is every ship's session the holds say.
func (r Runtime) List() ([]Observed, error) {
	folders, err := os.ReadDir(r.Sessions)
	if errors.Is(err, os.ErrNotExist) {
		return []Observed{}, nil
	}
	if err != nil {
		return nil, err
	}
	sessions := []Observed{}
	for _, folder := range folders {
		if !shipIDPattern.MatchString(folder.Name()) {
			continue
		}
		if session, ok := r.observed(folder.Name()); ok {
			sessions = append(sessions, session)
		}
	}
	return sessions, nil
}

// Stop ends the ship's hold, and its harness with it, then removes its files.
func (r Runtime) Stop(shipID string) error {
	if pid := r.runningPID(shipID); pid != 0 {
		_ = syscall.Kill(pid, syscall.SIGTERM)
		until := time.Now().Add(stopWait)
		for r.runningPID(shipID) != 0 && time.Now().Before(until) {
			time.Sleep(startPoll)
		}
		if r.runningPID(shipID) != 0 {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	return os.RemoveAll(hold.FilesOf(r.Sessions, shipID).Folder)
}

// Start starts the ship's session under a hold of its own, its last one stopped first, and returns once the hold answers.
func (r Runtime) Start(session Start) error {
	if err := r.Stop(session.ShipID); err != nil {
		return err
	}
	files := hold.FilesOf(r.Sessions, session.ShipID)
	if err := os.MkdirAll(files.Folder, 0o700); err != nil {
		return err
	}
	words := append(append([]string{}, r.Program...), "hold", session.ShipID, "--sessions", r.Sessions, "--folder", session.Folder, "--harness", session.Harness)
	for name, value := range session.Env {
		words = append(words, "--env", name+"="+value)
	}
	words = append(append(words, "--"), session.Command...)
	line := append(append(append([]string{}, r.Launch...), "sh", "-c", detached, "sh"), words...)
	starter := exec.Command(line[0], line[1:]...)
	starter.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if wrote, err := starter.CombinedOutput(); err != nil {
		return fmt.Errorf("the hold of %s did not start: %s ended with %v: %s", session.ShipID, line[0], err, strings.TrimSpace(string(wrote)))
	}
	until := time.Now().Add(startWait)
	for time.Now().Before(until) {
		if answer, err := hold.Call(files.Socket, hold.Request{Call: "state"}, callTimeout); err == nil && answer.IsOK {
			return nil
		}
		// A hold whose harness ended at once has ended too: its exit is seen in the next list.
		if _, err := os.Stat(files.PID); err == nil && r.runningPID(session.ShipID) == 0 {
			return nil
		}
		time.Sleep(startPoll)
	}
	return fmt.Errorf("the hold of %s did not answer within %s of its start", session.ShipID, startWait)
}

// Interrupt stops the session's busy turn, which the hold may wait for as long as an interrupted turn takes.
func (r Runtime) Interrupt(shipID string) error {
	return r.must(shipID, hold.Request{Call: "interrupt"}, hold.InterruptWait+callTimeout)
}

func (r Runtime) must(shipID string, request hold.Request, timeout time.Duration) error {
	answer, err := hold.Call(hold.FilesOf(r.Sessions, shipID).Socket, request, timeout)
	if err != nil {
		return err
	}
	if !answer.IsOK {
		return fmt.Errorf("the hold of %s refused %s: %s", shipID, request.Call, answer.Error)
	}
	return nil
}

// Send sends the line to the ship's session.
func (r Runtime) Send(shipID string, line string) error {
	return r.must(shipID, hold.Request{Call: "send", Line: line}, callTimeout)
}
