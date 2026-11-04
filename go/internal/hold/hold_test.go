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
	return aHoldOf(t, Options{Command: []string{"sh", "-c", script}})
}

// aHoldOf runs a hold in this process with the options given, its files, folder, environment, version and stop its own.
func aHoldOf(t *testing.T, options Options) aRunningHold {
	t.Helper()
	files := FilesOf(shortFolder(t), ship)
	stop := make(chan struct{})
	ended := make(chan int, 1)
	options.Files, options.Folder, options.Environment, options.Version, options.Stop = files, t.TempDir(), []string{"PATH=/usr/bin:/bin"}, "1.2.3", stop
	go func() {
		ended <- Run(options)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := Call(files.Socket, Request{Call: "state"}, time.Second); err == nil {
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

// aClaudeCodeHold is a hold of a harness that answers as Claude Code does in stream-json: each start noted in the starts file with its words, a turn per line but one saying slowly, which runs until it is interrupted; the interrupt control request ends the turn, or is refused when isRefusing; SIGINT ends the turn and the process.
func aClaudeCodeHold(t *testing.T, starts string, isRefusing bool) aRunningHold {
	t.Helper()
	answer := `printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s"}}\n{"type":"result","subtype":"error_during_execution","session_id":"fake-1"}\n' "$id"`
	if isRefusing {
		answer = `printf '{"type":"control_response","response":{"subtype":"error","request_id":"%s","error":"interrupt is not supported"}}\n' "$id"`
	}
	script := `echo "$0 $*" >> ` + starts + `
echo '{"type":"system","subtype":"init","session_id":"fake-1"}'
trap 'echo "{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"session_id\":\"fake-1\"}"; exit 0' INT
while read -r line; do
  case "$line" in
    *control_request*) id=$(printf '%s' "$line" | sed 's/.*"request_id":"\([^"]*\)".*/\1/'); ` + answer + ` ;;
    *slowly*) : ;;
    *) echo '{"type":"result","subtype":"success","session_id":"fake-1"}' ;;
  esac
done`
	return aHoldOf(t, Options{Harness: "claude-code", Command: []string{"sh", "-c", script}})
}

func lines(path string) []string {
	text := strings.TrimSpace(read(path))
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

func TestAnInterruptStopsTheBusyTurnWithTheControlRequestAndTheHarnessStays(t *testing.T) {
	starts := filepath.Join(t.TempDir(), "starts")
	hold := aClaudeCodeHold(t, starts, false)
	if _, err := Call(hold.files.Socket, Request{Call: "send", Line: `{"type":"user","text":"work slowly"}`}, time.Second); err != nil {
		t.Fatal(err)
	}

	answer, err := Call(hold.files.Socket, Request{Call: "interrupt"}, 15*time.Second)

	if err != nil || !answer.IsOK {
		t.Fatalf("interrupt = %+v %v, want ok", answer, err)
	}
	if got := read(hold.files.Events); !strings.Contains(got, `"request_id":"aeolus-interrupt-1"`) || !strings.Contains(got, "error_during_execution") {
		t.Fatalf("events = %s, want the control response and the turn ended", got)
	}
	if got := lines(starts); len(got) != 1 {
		t.Fatalf("starts = %v, want the one start", got)
	}
}

func TestAnInterruptClaudeCodeRefusesEndsTheTurnWithSIGINTAndResumesItsSession(t *testing.T) {
	starts := filepath.Join(t.TempDir(), "starts")
	hold := aClaudeCodeHold(t, starts, true)
	eventually(t, "the session id kept", func() bool { return read(hold.files.SessionID) == "fake-1" })
	if _, err := Call(hold.files.Socket, Request{Call: "send", Line: `{"type":"user","text":"work slowly"}`}, time.Second); err != nil {
		t.Fatal(err)
	}

	answer, err := Call(hold.files.Socket, Request{Call: "interrupt"}, 15*time.Second)

	if err != nil || !answer.IsOK {
		t.Fatalf("interrupt = %+v %v, want ok", answer, err)
	}
	eventually(t, "the harness started again", func() bool { return len(lines(starts)) == 2 })
	if got := lines(starts)[1]; got != "--resume fake-1" {
		t.Fatalf("the second start's words = %q, want %q", got, "--resume fake-1")
	}
	select {
	case code := <-hold.ended:
		hold.ended <- code
		t.Fatalf("the hold ended (%d), want it to go on with the resumed session", code)
	default:
	}
	if _, err := Call(hold.files.Socket, Request{Call: "send", Line: `{"type":"user","text":"hello"}`}, time.Second); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the resumed session's turn", func() bool { return strings.Contains(read(hold.files.Events), `"subtype":"success"`) })
}

func TestAnInterruptOfAnIdleTurnStopsNothing(t *testing.T) {
	starts := filepath.Join(t.TempDir(), "starts")
	hold := aClaudeCodeHold(t, starts, false)
	if _, err := Call(hold.files.Socket, Request{Call: "send", Line: `{"type":"user","text":"hello"}`}, time.Second); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the turn ended", func() bool { return strings.Contains(read(hold.files.Events), `"subtype":"success"`) })

	answer, err := Call(hold.files.Socket, Request{Call: "interrupt"}, 15*time.Second)

	if err != nil || !answer.IsOK {
		t.Fatalf("interrupt = %+v %v, want ok", answer, err)
	}
	if got := read(hold.files.Events); strings.Contains(got, "control_response") {
		t.Fatalf("events = %s, want no control request for an idle turn", got)
	}
}

func TestACallerTheHoldMayNotAnswerIsRefused(t *testing.T) {
	hold := aHoldOf(t, Options{Command: []string{"sh", "-c", anEchoHarness}, MayCall: func(int) bool { return false }})

	answer, err := Call(hold.files.Socket, Request{Call: "state"}, time.Second)

	if err != nil || answer.IsOK || answer.Error != Refused {
		t.Fatalf("state = %+v %v, want refused with %q", answer, err, Refused)
	}
}
