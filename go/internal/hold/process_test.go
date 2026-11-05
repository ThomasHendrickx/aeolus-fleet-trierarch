package hold

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestMain lets this test binary be the trierarch program a hold is started as, `<binary> hold ...`, and a caller of a hold's socket, `<binary> call <socket> <answer file>`.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "hold" {
		os.Exit(Main(os.Args[2:], "1.2.3", os.Environ()))
	}
	if len(os.Args) > 3 && os.Args[1] == "call" {
		answer, err := Call(os.Args[2], Request{Call: "state"}, 2*time.Second)
		text, _ := json.Marshal(answer)
		if err != nil {
			text = []byte(err.Error())
		}
		_ = os.WriteFile(os.Args[3], text, 0o600)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// aHoldProcess starts a hold as the trierarch does, a process of its own running this test binary as `hold`, and waits until it answers.
func aHoldProcess(t *testing.T, script string) (Files, *exec.Cmd) {
	t.Helper()
	return aHoldProcessOf(t, shortFolder(t), ship, script)
}

// aHoldProcessOf starts the ship's hold in the sessions folder; its harness finds the hold's socket in SOCKET and this test binary in CALLER.
func aHoldProcessOf(t *testing.T, sessions string, shipID string, script string) (Files, *exec.Cmd) {
	t.Helper()
	files := FilesOf(sessions, shipID)
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	folder := t.TempDir()
	command := exec.Command(program, "hold", shipID, "--sessions", sessions, "--folder", folder, "--harness", "claude-code", "--env", "CALLER="+program, "--env", "SOCKET="+files.Socket, "--", "sh", "-c", script)
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() {
		_ = command.Wait()
		close(exited)
	}()
	t.Cleanup(func() {
		_ = command.Process.Signal(syscall.SIGTERM)
		select {
		case <-exited:
		case <-time.After(10 * time.Second):
			_ = command.Process.Kill()
		}
	})
	eventually(t, "the hold answering", func() bool {
		answer, err := Call(files.Socket, Request{Call: "state"}, time.Second)
		return err == nil && answer.IsOK
	})
	return files, command
}

// isGone holds once no process has the pid, or only a zombie, as ps says it on Linux and macOS alike, which has no /proc.
func isGone(pid string) bool {
	state, err := exec.Command("ps", "-o", "stat=", "-p", pid).Output()
	return err != nil || strings.HasPrefix(strings.TrimSpace(string(state)), "Z")
}

func TestAHoldKilledWithNoChanceToStopStillEndsItsHarnessAndWhatItStarted(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "pids")
	_, hold := aHoldProcess(t, `sleep 300 & echo "$$ $!" > `+marker+`; wait`)
	eventually(t, "the harness's pids", func() bool { return len(strings.Fields(read(marker))) == 2 })

	if err := hold.Process.Signal(syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}

	for _, pid := range strings.Fields(read(marker)) {
		eventually(t, "process "+pid+" ended", func() bool { return isGone(pid) })
	}
}

func TestTheGuardIsAProcessOfItsOwnAndNoNodeScript(t *testing.T) {
	files, hold := aHoldProcess(t, `while read -r line; do :; done`)

	guards := childrenOf(t, hold.Process.Pid)
	program, _ := os.Executable()

	found := false
	for _, pid := range guards {
		line, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
		if err == nil && strings.HasPrefix(strings.TrimSpace(string(line)), program+" hold --guard") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no `%s hold --guard` among the children of the hold %d (%s)", program, hold.Process.Pid, files.Folder)
	}
}

// childrenOf is every process whose parent is the pid, as ps lists them.
func childrenOf(t *testing.T, pid int) []int {
	t.Helper()
	listed, err := exec.Command("ps", "-A", "-o", "pid=,ppid=").Output()
	if err != nil {
		t.Fatalf("ps -A -o pid=,ppid=: %v", err)
	}
	var children []int
	for _, line := range strings.Split(string(listed), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || fields[1] != strconv.Itoa(pid) {
			continue
		}
		if child, err := strconv.Atoi(fields[0]); err == nil {
			children = append(children, child)
		}
	}
	return children
}

func TestTheHoldAnswersTheTrierarch(t *testing.T) {
	files, _ := aHoldProcess(t, `while read -r line; do :; done`)

	answer, err := Call(files.Socket, Request{Call: "state"}, time.Second)

	if err != nil || !answer.IsOK {
		t.Fatalf("state from the trierarch = %+v %v, want ok", answer, err)
	}
}

func TestTheHoldRefusesItsOwnSession(t *testing.T) {
	answered := filepath.Join(t.TempDir(), "answer")
	aHoldProcess(t, `"$CALLER" call "$SOCKET" `+answered+`; while read -r line; do :; done`)

	eventually(t, "the session's call answered", func() bool { return read(answered) != "" })

	if got := read(answered); !strings.Contains(got, Refused) {
		t.Fatalf("the session's own call = %s, want %q", got, Refused)
	}
}

func TestTheHoldRefusesAnotherShipsSession(t *testing.T) {
	sessions := shortFolder(t)
	scout, _ := aHoldProcessOf(t, sessions, ship, `while read -r line; do :; done`)
	answered := filepath.Join(t.TempDir(), "answer")

	aHoldProcessOf(t, sessions, "shp_01m6jyczpnpp5c0vxh54c966cz", `"$CALLER" call `+scout.Socket+` `+answered+`; while read -r line; do :; done`)

	eventually(t, "the other session's call answered", func() bool { return read(answered) != "" })
	if got := read(answered); !strings.Contains(got, Refused) {
		t.Fatalf("another ship's session's call = %s, want %q", got, Refused)
	}
}

func TestTheHoldRefusesAProcessAnotherShipsSessionForkedOnceItIsReparented(t *testing.T) {
	sessions := shortFolder(t)
	scout, _ := aHoldProcessOf(t, sessions, ship, `while read -r line; do :; done`)
	answered := filepath.Join(t.TempDir(), "answer")

	// The subshell ends at once, so the process it forked calls once its parent is gone.
	aHoldProcessOf(t, sessions, "shp_01m6jyczpnpp5c0vxh54c966cz", `( (sleep 1; "$CALLER" call `+scout.Socket+` `+answered+`) & ); while read -r line; do :; done`)

	eventually(t, "the reparented process's call answered", func() bool { return read(answered) != "" })
	if got := read(answered); !strings.Contains(got, Refused) {
		t.Fatalf("a reparented process of another ship's session called = %s, want %q", got, Refused)
	}
}

// A process that deliberately leaves its session's process session (setsid) and is reparented is answered: no refusal list tells it from the trierarch, and a container is the isolation against it (#196, #174).
func TestTheHoldAnswersAProcessThatLeftAnotherShipsSessionByItsOwnSetsidOnceItIsReparented(t *testing.T) {
	sessions := shortFolder(t)
	scout, _ := aHoldProcessOf(t, sessions, ship, `while read -r line; do :; done`)
	answered := filepath.Join(t.TempDir(), "answer")

	// perl's setsid, as macOS has no setsid command; the subshell ends at once, so the process calls once its parent is gone.
	aHoldProcessOf(t, sessions, "shp_01m6jyczpnpp5c0vxh54c966cz", `( perl -MPOSIX -e 'POSIX::setsid(); sleep 1; exec @ARGV' "$CALLER" call `+scout.Socket+` `+answered+` & ); while read -r line; do :; done`)

	eventually(t, "the call of the process that left its session answered", func() bool { return read(answered) != "" })
	if got := read(answered); !strings.Contains(got, `"isOk":true`) {
		t.Fatalf("a reparented process that left another ship's session called = %s, want it answered", got)
	}
}
