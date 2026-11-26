package hold

import (
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestWorkingTimeExcludesQuestionUsageLimitAndIdleWaits(t *testing.T) {
	var seconds atomic.Int64
	now := func() time.Time { return time.Unix(1_800_000_000+seconds.Load(), 0) }
	path := filepath.Join(t.TempDir(), "working-time.json")
	session := aHoldOf(t, Options{
		Harness:         "claude-code",
		WorkingTimePath: path,
		Now:             now,
		Command: []string{"sh", "-c", `
			while read -r line; do
				case "$line" in
					start) echo '{"type":"waiting_for_activity"}' ;;
					finish) echo '{"type":"result","is_error":true,"subtype":"error_during_execution"}' ;;
				esac
			done
		`},
	})
	call := func(request Request) {
		t.Helper()
		answer, err := Call(session.files.Socket, request, time.Second)
		if err != nil || !answer.IsOK {
			t.Fatalf("%s = %+v, %v", request.Call, answer, err)
		}
	}
	check := func(want time.Duration) {
		t.Helper()
		got, known := ReadWorkingTime(path, now(), true)
		if !known || got != want {
			t.Fatalf("working time = %s (known %t), want %s", got, known, want)
		}
	}

	seconds.Store(600)
	check(0)
	call(Request{Call: "send", Line: "start"})
	seconds.Store(630)
	call(Request{Call: "wait-started", Line: "question-one"})
	call(Request{Call: "wait-started", Line: "question-two"})
	seconds.Store(660)
	call(Request{Call: "wait-ended", Line: "question-one"})
	check(30 * time.Second)
	seconds.Store(900)
	call(Request{Call: "wait-ended", Line: "question-two"})
	seconds.Store(930)
	check(time.Minute)
	call(Request{Call: "send", Line: "finish"})
	eventually(t, "the failed turn stopped working", func() bool {
		got, known := ReadWorkingTime(path, now().Add(time.Minute), true)
		return known && got == time.Minute && strings.Contains(read(session.files.Events), "error_during_execution")
	})
	seconds.Store(1800)
	check(time.Minute)
	call(Request{Call: "send", Line: "start"})
	seconds.Store(1830)
	check(90 * time.Second)
}

func TestPriorWorkingTimeSurvivesANewHold(t *testing.T) {
	var seconds atomic.Int64
	now := func() time.Time { return time.Unix(1_800_000_000+seconds.Load(), 0) }
	path := filepath.Join(t.TempDir(), "working-time.json")
	options := Options{
		Harness: "claude-code", WorkingTimePath: path, Now: now,
		Command: []string{"sh", "-c", `while read -r line; do
            if [ "$line" = finish ]; then echo '{"type":"result"}'; fi
        done`},
	}
	first := aHoldOf(t, options)
	for _, line := range []string{"start", "finish"} {
		if answer, err := Call(first.files.Socket, Request{Call: "send", Line: line}, time.Second); err != nil || !answer.IsOK {
			t.Fatalf("send %s = %+v, %v", line, answer, err)
		}
		seconds.Store(75)
	}
	eventually(t, "a completed turn record", func() bool {
		got, known := ReadWorkingTime(path, now().Add(time.Minute), false)
		return known && got == 75*time.Second && strings.Contains(read(first.files.Events), "result")
	})
	close(first.stop)
	eventually(t, "the first hold to close", func() bool {
		_, err := Call(first.files.Socket, Request{Call: "state"}, time.Second)
		return err != nil
	})
	seconds.Store(600)
	aHoldOf(t, options)
	got, known := ReadWorkingTime(path, now(), true)
	if !known || got != 75*time.Second {
		t.Fatalf("working time after restart = %s (known %t), want 75s", got, known)
	}
}

func TestWorkingTimeIsUnknownWithoutCompleteEvidence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "working-time.json")
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	if _, known := ReadWorkingTime(path, now, false); known {
		t.Fatal("missing working time reads as known")
	}
	session := aHoldOf(t, Options{Harness: "claude-code", Command: []string{"sh", "-c", "read -r line; read -r line"}, WorkingTimePath: path, Now: func() time.Time { return now }})
	if answer, err := Call(session.files.Socket, Request{Call: "send", Line: "{}"}, time.Second); err != nil || !answer.IsOK {
		t.Fatalf("send = %+v, %v", answer, err)
	}
	if _, known := ReadWorkingTime(path, now.Add(time.Minute), false); known {
		t.Fatal("an open turn with no running hold reads as known")
	}
}

func TestARejectedUsageWindowPausesWorkingTimeBeforeTheTurnEnds(t *testing.T) {
	var seconds atomic.Int64
	now := func() time.Time { return time.Unix(1_800_000_000+seconds.Load(), 0) }
	path := filepath.Join(t.TempDir(), "working-time.json")
	session := aHoldOf(t, Options{
		Harness: "claude-code", WorkingTimePath: path, Now: now,
		Command: []string{"sh", "-c", `while read -r line; do printf '%s\n' "$line"; done`},
	})
	send := func(event string, after time.Duration, want time.Duration) {
		t.Helper()
		answer, err := Call(session.files.Socket, Request{Call: "send", Line: event}, time.Second)
		if err != nil || !answer.IsOK {
			t.Fatalf("send = %+v, %v", answer, err)
		}
		eventually(t, "the working time after "+event, func() bool {
			got, known := ReadWorkingTime(path, now().Add(after), true)
			return known && got == want
		})
	}

	send(`{"type":"system"}`, 30*time.Second, 30*time.Second)
	seconds.Store(30)
	send(`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}`, 10*time.Minute, 30*time.Second)
	seconds.Store(630)
	send(`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}`, time.Minute, 90*time.Second)
	seconds.Store(690)
	send(`{"type":"result"}`, 10*time.Minute, 90*time.Second)
}
