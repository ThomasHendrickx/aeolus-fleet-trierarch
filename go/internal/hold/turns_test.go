package hold

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// aCodexHold is a hold of a harness that answers as `codex exec --json` does, one process per turn: each start noted in the starts file with its words, reading its stdin to its end first, the first turn naming its thread, a slow turn running until SIGINT ends it. A slow turn traps SIGINT before its start is noted, so a SIGINT to a start seen always aborts the turn: one between them would end the shell unheard.
func aCodexHold(t *testing.T, starts string, start ...string) aRunningHold {
	t.Helper()
	script := `cat > /dev/null
case "$*" in
  *slowly*) trap 'echo "{\"type\":\"turn.aborted\"}"; exit 130' INT ;;
esac
echo "$*" >> ` + starts + `
if [ "$2" != resume ]; then echo '{"type":"thread.started","thread_id":"thread-1"}'; fi
case "$*" in
  *slowly*) sleep 30 > /dev/null & wait ;;
  *quickly*) sleep 0.5 ;;
esac
last=$(eval echo \${$#})
printf '{"type":"turn.completed","prompt":"%s"}\n' "$last"`
	return aHoldOf(t, Options{Harness: "codex", Command: append([]string{"sh", "-c", script, "sh"}, start...)})
}

func TestACodexHoldRunsItsStartAsTheFirstTurnWithNoStdinAndKeepsTheThreadItNamed(t *testing.T) {
	starts := filepath.Join(t.TempDir(), "starts")
	hold := aCodexHold(t, starts, "exec", "--json", "--", "first")

	eventually(t, "the first turn completed", func() bool { return strings.Contains(read(hold.files.Events), `"prompt":"first"`) })
	eventually(t, "the thread kept", func() bool { return read(hold.files.SessionID) == "thread-1" })
	time.Sleep(200 * time.Millisecond)

	answer, err := Call(hold.files.Socket, Request{Call: "state"}, time.Second)
	if err != nil || !answer.IsOK || answer.State == nil || answer.State.SessionID != "thread-1" {
		t.Fatalf("state after the first turn = %+v %v, want the hold running with thread-1", answer, err)
	}
}

func TestALineSentToACodexHoldIsATurnOfItsOwnResumingItsThread(t *testing.T) {
	for _, test := range []struct {
		name  string
		start []string
	}{
		{"after a first start", []string{"exec", "--json", "--", "first"}},
		{"after a start on the folder's last conversation", []string{"exec", "resume", "--last", "--json", "--", "wake"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			starts := filepath.Join(t.TempDir(), "starts")
			script := `cat > /dev/null; echo "$*" >> ` + starts + `; echo '{"type":"thread.started","thread_id":"thread-1"}'; echo '{"type":"turn.completed"}'`
			hold := aHoldOf(t, Options{Harness: "codex", Command: append([]string{"sh", "-c", script, "sh"}, test.start...)})
			eventually(t, "the thread kept", func() bool { return read(hold.files.SessionID) == "thread-1" })

			answer, err := Call(hold.files.Socket, Request{Call: "send", Line: "hello"}, 15*time.Second)

			if err != nil || !answer.IsOK {
				t.Fatalf("send = %+v %v, want ok", answer, err)
			}
			eventually(t, "the turn started", func() bool { return len(lines(starts)) == 2 })
			if got, want := lines(starts)[1], "exec resume thread-1 --json -- hello"; got != want {
				t.Fatalf("the turn's words = %q, want %q", got, want)
			}
		})
	}
}

func TestALineSentWhileACodexTurnRunsStartsItsTurnOnceThatTurnEnded(t *testing.T) {
	starts := filepath.Join(t.TempDir(), "starts")
	hold := aCodexHold(t, starts, "exec", "--json", "--", "work quickly")
	eventually(t, "the thread kept", func() bool { return read(hold.files.SessionID) == "thread-1" })

	if answer, err := Call(hold.files.Socket, Request{Call: "send", Line: "hello"}, 15*time.Second); err != nil || !answer.IsOK {
		t.Fatalf("send = %+v %v, want ok", answer, err)
	}

	eventually(t, "the second turn completed", func() bool { return strings.Contains(read(hold.files.Events), `"prompt":"hello"`) })
	events := read(hold.files.Events)
	if strings.Index(events, `"prompt":"work quickly"`) > strings.Index(events, `"prompt":"hello"`) {
		t.Fatalf("events = %s, want the first turn ended before the second", events)
	}
}

func TestALineSentBeforeCodexNamedAThreadIsRefused(t *testing.T) {
	hold := aHoldOf(t, Options{Harness: "codex", Command: []string{"sh", "-c", `cat > /dev/null; echo '{"type":"turn.failed","error":{"message":"no"}}'`}})
	eventually(t, "the first turn ended", func() bool { return strings.Contains(read(hold.files.Events), "turn.failed") })

	answer, err := Call(hold.files.Socket, Request{Call: "send", Line: "hello"}, 15*time.Second)

	if err != nil || answer.IsOK || answer.Error != "Codex named no thread to resume yet" {
		t.Fatalf("send = %+v %v, want refused as no thread named", answer, err)
	}
}

func TestAnInterruptEndsACodexTurnWithSIGINTAndTheHoldStays(t *testing.T) {
	starts := filepath.Join(t.TempDir(), "starts")
	hold := aCodexHold(t, starts, "exec", "--json", "--", "first")
	eventually(t, "the thread kept", func() bool { return read(hold.files.SessionID) == "thread-1" })
	if _, err := Call(hold.files.Socket, Request{Call: "send", Line: "work slowly"}, 15*time.Second); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the slow turn started", func() bool { return len(lines(starts)) == 2 })

	answer, err := Call(hold.files.Socket, Request{Call: "interrupt"}, 15*time.Second)

	if err != nil || !answer.IsOK {
		t.Fatalf("interrupt = %+v %v, want ok", answer, err)
	}
	eventually(t, "the turn aborted", func() bool { return strings.Contains(read(hold.files.Events), "turn.aborted") })
	if state, err := Call(hold.files.Socket, Request{Call: "state"}, time.Second); err != nil || !state.IsOK {
		t.Fatalf("state after the interrupt = %+v %v, want the hold running", state, err)
	}
}

// aCopilotHold is a hold of a harness that answers as `copilot -p` behind its npm launcher does, one process per turn: each start noted with its words, reading its stdin to its end first, a line on stderr, the native process writing the result naming the session after the launcher exited, a failing turn exiting 1, a slow one running until SIGINT ends its group: a SIGINT to the launcher alone waits for its child.
func aCopilotHold(t *testing.T, starts string, prompt string) aRunningHold {
	t.Helper()
	return aCopilotHoldSleepingAt(t, starts, prompt, filepath.Join(t.TempDir(), "sleeping"))
}

// aCopilotHoldSleepingAt is a Copilot hold whose slow turn has its child write the file sleeping, then become the sleep: once the file is there, the launcher waits on a running child, where a SIGINT reaches both.
func aCopilotHoldSleepingAt(t *testing.T, starts string, prompt string, sleeping string) aRunningHold {
	t.Helper()
	script := `cat > /dev/null
echo "$*" >> ` + starts + `
echo 'warning: something' >&2
case "$*" in
  *fail*) sleep 0.5; echo 'Error: Model "gpt-0" from --model flag is not available.' >&2; exit 1 ;;
  *slowly*) sh -c 'echo started > ` + sleeping + `; exec sleep 30' ;;
esac
( sleep 0.3; echo '{"type":"result","sessionId":"copilot-1","exitCode":0}' ) &
exit 0`
	return aHoldOf(t, Options{Harness: "copilot", Command: []string{"sh", "-c", script, "sh", "--output-format=json", "--prompt=" + prompt}})
}

func TestACopilotHoldKeepsWhatCopilotWritesOnStderrAmongTheEvents(t *testing.T) {
	hold := aCopilotHold(t, filepath.Join(t.TempDir(), "starts"), "first")

	eventually(t, "the stderr line kept", func() bool {
		return strings.Contains(read(hold.files.Events), `{"type":"aeolus.stderr","line":"warning: something"}`)
	})
}

func TestALineSentToACopilotHoldResumesTheSessionTheLastTurnNamedOnceItsOutputClosed(t *testing.T) {
	starts := filepath.Join(t.TempDir(), "starts")
	hold := aCopilotHold(t, starts, "first")
	eventually(t, "the first turn started", func() bool { return len(lines(starts)) == 1 })

	answer, err := Call(hold.files.Socket, Request{Call: "send", Line: "hello"}, 15*time.Second)

	if err != nil || !answer.IsOK {
		t.Fatalf("send = %+v %v, want ok", answer, err)
	}
	eventually(t, "the turn started", func() bool { return len(lines(starts)) == 2 })
	if got, want := lines(starts)[1], "--output-format=json --resume=copilot-1 --prompt=hello"; got != want {
		t.Fatalf("the turn's words = %q, want %q", got, want)
	}
}

func TestACopilotTurnThatFailsEndsTheHoldWithItsStatus(t *testing.T) {
	hold := aCopilotHold(t, filepath.Join(t.TempDir(), "starts"), "fail")

	select {
	case code := <-hold.ended:
		hold.ended <- code
		if code != 1 {
			t.Fatalf("exit code = %d, want 1", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("the hold did not end with the failed turn")
	}
}

func TestAnInterruptEndsACopilotTurnInItsWholeProcessGroup(t *testing.T) {
	starts := filepath.Join(t.TempDir(), "starts")
	sleeping := filepath.Join(t.TempDir(), "sleeping")
	hold := aCopilotHoldSleepingAt(t, starts, "first", sleeping)
	eventually(t, "the session named", func() bool { return read(hold.files.SessionID) == "copilot-1" })
	if _, err := Call(hold.files.Socket, Request{Call: "send", Line: "work slowly"}, 15*time.Second); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the slow turn sleeping", func() bool { return read(sleeping) != "" })
	began := time.Now()

	answer, err := Call(hold.files.Socket, Request{Call: "interrupt"}, 15*time.Second)

	if err != nil || !answer.IsOK {
		t.Fatalf("interrupt = %+v %v, want ok", answer, err)
	}
	if took := time.Since(began); took > 5*time.Second {
		t.Fatalf("the interrupt took %v, want the turn's whole group ended at once", took)
	}
	if state, err := Call(hold.files.Socket, Request{Call: "state"}, time.Second); err != nil || !state.IsOK {
		t.Fatalf("state after the interrupt = %+v %v, want the hold running", state, err)
	}
}
