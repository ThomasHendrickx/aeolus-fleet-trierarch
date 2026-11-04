package hold

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const ship = "shp_01m6jyczpnpp5c0vxh54c966cy"

// anEchoHarness answers each stdin line as Claude Code does in stream-json: a result naming its session, holding what it got.
const anEchoHarness = `echo '{"type":"system","subtype":"init","session_id":"fake-1"}'; while read -r line; do printf '{"type":"result","session_id":"fake-1","got":%s}\n' "$line"; done`

type aRunningHold struct {
	files Files
	stop  chan struct{}
	ended chan int
}

func aHold(t *testing.T, script string) aRunningHold {
	t.Helper()
	files := FilesOf(shortFolder(t), ship)
	folder := t.TempDir()
	stop := make(chan struct{})
	ended := make(chan int, 1)
	go func() {
		ended <- Run(Options{Files: files, Folder: folder, Command: []string{"sh", "-c", script}, Environment: []string{"PATH=/usr/bin:/bin"}, Version: "1.2.3", Stop: stop})
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if answer, err := Call(files.Socket, Request{Call: "state"}, time.Second); err == nil && answer.IsOK {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the hold did not answer within 5 s")
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Cleanup(func() {
		select {
		case <-stop:
		default:
			close(stop)
		}
		<-ended
	})
	return aRunningHold{files: files, stop: stop, ended: ended}
}

// shortFolder is a temporary folder with a path short enough for a socket in it: a test's own is too long.
func shortFolder(t *testing.T) string {
	t.Helper()
	folder, err := os.MkdirTemp("", "hold")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(folder) })
	return folder
}

func eventually(t *testing.T, what string, isIt func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !isIt() {
		if time.Now().After(deadline) {
			t.Fatalf("%s did not happen within 5 s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func read(path string) string {
	text, _ := os.ReadFile(path)
	return string(text)
}

func TestTheHoldSaysItsPidInItsFolder(t *testing.T) {
	hold := aHold(t, anEchoHarness)

	if got := strings.TrimSpace(read(hold.files.PID)); got == "" || got == "0" {
		t.Fatalf("hold.pid: %q", got)
	}
	if filepath.Dir(hold.files.PID) != hold.files.Folder {
		t.Fatalf("hold.pid is not in the session's folder: %s", hold.files.PID)
	}
}

func TestALineSentGoesToTheHarnessAndWhatItWritesIsKeptInTheEvents(t *testing.T) {
	hold := aHold(t, anEchoHarness)

	answer, err := Call(hold.files.Socket, Request{Call: "send", Line: `{"type":"user"}`}, time.Second)

	if err != nil || !answer.IsOK {
		t.Fatalf("send: %+v %v", answer, err)
	}
	eventually(t, "the result in the events", func() bool {
		return strings.Contains(read(hold.files.Events), `"got":{"type":"user"}`)
	})
}

func TestTheStateSaysRunningItsVersionAndTheSessionIdTheHarnessNamed(t *testing.T) {
	hold := aHold(t, anEchoHarness)
	eventually(t, "the session id kept", func() bool { return read(hold.files.SessionID) == "fake-1" })

	answer, err := Call(hold.files.Socket, Request{Call: "state"}, time.Second)

	if err != nil || !answer.IsOK || answer.State == nil || answer.State.Status != "running" || answer.State.Version != "1.2.3" || answer.State.SessionID != "fake-1" {
		t.Fatalf("state: %+v %v", answer, err)
	}
}

func TestACallItDoesNotKnowIsRefused(t *testing.T) {
	hold := aHold(t, anEchoHarness)

	answer, err := Call(hold.files.Socket, Request{Call: "dance"}, time.Second)

	if err != nil || answer.IsOK || answer.Error == "" {
		t.Fatalf("answer: %+v %v", answer, err)
	}
}

func TestTheHoldEndsWhenItsHarnessEndsAndAnswersNoMore(t *testing.T) {
	hold := aHold(t, `read -r line; exit 3`)

	if _, err := Call(hold.files.Socket, Request{Call: "send", Line: "{}"}, time.Second); err != nil {
		t.Fatalf("send: %v", err)
	}

	select {
	case code := <-hold.ended:
		hold.ended <- code
		if code != 3 {
			t.Fatalf("exit code: %d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("the hold did not end with its harness")
	}
	if _, err := Call(hold.files.Socket, Request{Call: "state"}, time.Second); err == nil {
		t.Fatalf("the hold still answers")
	}
}

func TestAStoppedHoldEndsItsHarnessAndEveryProcessItStarted(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "child.pid")
	hold := aHold(t, `sleep 300 & echo $! > `+marker+`; wait`)
	eventually(t, "the child's pid", func() bool { return strings.TrimSpace(read(marker)) != "" })

	close(hold.stop)

	select {
	case code := <-hold.ended:
		hold.ended <- code
	case <-time.After(5 * time.Second):
		t.Fatalf("the hold did not end")
	}
	pid := strings.TrimSpace(read(marker))
	eventually(t, "the harness's child ended", func() bool {
		_, err := os.Stat("/proc/" + pid)
		return err != nil || strings.Contains(read("/proc/"+pid+"/stat"), ") Z ")
	})
}
