package peer

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// connectTo is the variable that makes this test binary a caller: it connects to the socket it names and waits until the connection ends.
const connectTo = "PEER_TEST_CONNECT_TO"

func TestMain(m *testing.M) {
	if socket := os.Getenv(connectTo); socket != "" {
		connection, err := net.Dial("unix", socket)
		if err != nil {
			os.Exit(1)
		}
		_, _ = connection.Read(make([]byte, 1))
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// aListener is a Unix socket in a folder of its own, short enough for a socket path.
func aListener(t *testing.T) (*net.UnixListener, string) {
	t.Helper()
	folder, err := os.MkdirTemp("", "peer")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(folder) })
	socket := filepath.Join(folder, "test.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener, socket
}

// aCaller starts the command as a caller of the socket and answers the connection the listener accepted from it.
func aCaller(t *testing.T, listener *net.UnixListener, command *exec.Cmd, socket string) (net.Conn, *exec.Cmd) {
	t.Helper()
	command.Env = append(os.Environ(), connectTo+"="+socket)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = command.Process.Kill()
		_ = command.Wait()
	})
	_ = listener.SetDeadline(time.Now().Add(5 * time.Second))
	connection, err := listener.Accept()
	if err != nil {
		t.Fatalf("no caller connected: %v", err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	return connection, command
}

func TestThePeerOfAConnectionIsTheProcessThatConnected(t *testing.T) {
	listener, socket := aListener(t)
	connection, caller := aCaller(t, listener, exec.Command(os.Args[0]), socket)

	got := PID(connection)

	if got != caller.Process.Pid {
		t.Fatalf("PID(connection) = %d, want %d", got, caller.Process.Pid)
	}
}

func TestACallerIsUnderEachProcessItDescendsFrom(t *testing.T) {
	listener, socket := aListener(t)
	// Not exec'd, so the shell stays between this test and the caller.
	connection, shell := aCaller(t, listener, exec.Command("sh", "-c", `"$0"; :`, os.Args[0]), socket)
	caller := PID(connection)

	cases := []struct {
		name  string
		roots []int
		want  bool
	}{
		{"its parent", []int{shell.Process.Pid}, true},
		{"its grandparent", []int{os.Getpid()}, true},
		{"itself", []int{caller}, true},
		{"one of the roots", []int{1 << 30, shell.Process.Pid}, true},
		{"no root", []int{}, false},
		{"a process it does not descend from", []int{1 << 30}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := IsUnder(caller, c.roots); got != c.want {
				t.Fatalf("IsUnder(%d, %v) = %v, want %v", caller, c.roots, got, c.want)
			}
		})
	}
}

func TestAProcessIsNotUnderItsOwnDescendant(t *testing.T) {
	listener, socket := aListener(t)
	connection, _ := aCaller(t, listener, exec.Command(os.Args[0]), socket)

	if IsUnder(os.Getpid(), []int{PID(connection)}) {
		t.Fatalf("IsUnder(%d, [its child]) = true, want false", os.Getpid())
	}
}

func TestNoPeerIsUnderAnything(t *testing.T) {
	if IsUnder(0, []int{os.Getpid()}) {
		t.Fatalf("IsUnder(0, [this process]) = true, want false")
	}
}
