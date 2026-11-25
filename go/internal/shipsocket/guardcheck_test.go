package shipsocket

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
)

// aDeny is the guard's answer to a call it refuses, as guard check gives it.
var aDeny = guard.Answer{Stdout: `{"hookSpecificOutput":{"permissionDecision":"deny"}}`, Stderr: "Refused by the guard: commands.deny npm publish, in no-publish @ 8d41e07.\n", ExitCode: 2}

// guardedSockets are sockets whose guard answers each call with check, every caller allowed unless refused.
func guardedSockets(t *testing.T, fleet *aFleet, isRefused bool, check func(ctx context.Context, shipID string, input io.ReadCloser) guard.Answer) *Sockets {
	t.Helper()
	token := "aeolus_ct_v1_scout"
	sockets := someSockets(t, fleet.server.URL, &token, isRefused)
	sockets.options.GuardCheck = check
	return sockets
}

const aToolCall = `{"tool_name":"Bash","tool_input":{"command":"npm publish"},"cwd":"/work"}`

func TestAGuardCheckIsAnsweredByTheShipsGuardAndNeverReachesTheFleet(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{}`)
	var checkedShip, checkedCall string
	socket := opened(t, guardedSockets(t, fleet, false, func(_ context.Context, shipID string, input io.ReadCloser) guard.Answer {
		text, _ := io.ReadAll(input)
		checkedShip, checkedCall = shipID, string(text)
		return guard.Answer{}
	}))

	response, body := post(t, socket, "/guard/check", aToolCall)

	if response.StatusCode != 200 || body != "" {
		t.Fatalf("answer = %d %q, want 200 and no body for a call the guard lets run", response.StatusCode, body)
	}
	if checkedShip != scout || checkedCall != aToolCall {
		t.Fatalf("the guard checked %q for %s, want %q for %s", checkedCall, checkedShip, aToolCall, scout)
	}
	if got := fleet.called(); len(got) != 0 {
		t.Fatalf("the fleet was called with %+v, want no call", got)
	}
}

func TestACallTheGuardRefusesIsAnsweredWithItsRefusalAndAFailingStatus(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{}`)
	socket := opened(t, guardedSockets(t, fleet, false, func(context.Context, string, io.ReadCloser) guard.Answer { return aDeny }))

	response, body := post(t, socket, "/guard/check", aToolCall)

	if response.StatusCode != http.StatusForbidden || body != aDeny.Stderr || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/plain") {
		t.Fatalf("answer = %d %s %q, want 403 text/plain %q", response.StatusCode, response.Header.Get("Content-Type"), body, aDeny.Stderr)
	}
}

func TestEveryWayTheGuardCheckFailsRefusesTheCall(t *testing.T) {
	for _, each := range []struct {
		name  string
		check func(ctx context.Context, shipID string, input io.ReadCloser) guard.Answer
		want  string
	}{
		{"no guard", nil, "Refused by the guard: guard failed: no guard.\n"},
		{"a panic", func(context.Context, string, io.ReadCloser) guard.Answer { panic("broken") }, "Refused by the guard: guard failed: panic.\n"},
		{"its deadline", func(ctx context.Context, _ string, _ io.ReadCloser) guard.Answer {
			time.Sleep(2 * time.Second)
			return guard.Answer{}
		}, "Refused by the guard: guard failed: deadline.\n"},
		{"an answer it cannot give", func(context.Context, string, io.ReadCloser) guard.Answer { return guard.Answer{ExitCode: 1} }, "Refused by the guard: guard failed: no answer.\n"},
	} {
		t.Run(each.name, func(t *testing.T) {
			fleet := aFleetAnswering(t, 200, "application/json", `{}`)
			sockets := guardedSockets(t, fleet, false, each.check)
			sockets.options.GuardDeadline = 200 * time.Millisecond
			socket := opened(t, sockets)
			started := time.Now()

			response, body := post(t, socket, "/guard/check", aToolCall)

			if response.StatusCode != http.StatusForbidden || body != each.want {
				t.Fatalf("answer = %d %q, want 403 %q", response.StatusCode, body, each.want)
			}
			if took := time.Since(started); took > time.Second {
				t.Fatalf("the refusal took %v, want it at the guard's deadline", took)
			}
		})
	}
}

func TestAGuardCheckFromAProcessOutsideTheShipsSessionIsRefusedUnchecked(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{}`)
	isChecked := false
	socket := opened(t, guardedSockets(t, fleet, true, func(context.Context, string, io.ReadCloser) guard.Answer {
		isChecked = true
		return guard.Answer{}
	}))

	response, _ := post(t, socket, "/guard/check", aToolCall)

	if response.StatusCode != http.StatusForbidden || isChecked {
		t.Fatalf("answer = %d, checked %t, want 403 and no check", response.StatusCode, isChecked)
	}
}

func TestAGuardCheckIsOnlyAPost(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{}`)
	socket := opened(t, guardedSockets(t, fleet, false, func(context.Context, string, io.ReadCloser) guard.Answer { return guard.Answer{} }))

	response, err := over(socket).Get("http://ship/guard/check")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()

	if response.StatusCode == 200 {
		t.Fatalf("GET /guard/check = %d, want a refusal", response.StatusCode)
	}
	if got := fleet.called(); len(got) != 0 {
		t.Fatalf("the fleet was called with %+v, want no call", got)
	}
}

// sent writes the request to the socket as it is, then answers the status line and the body the socket answers within a second.
func sent(t *testing.T, socket string, request string) (int, string) {
	t.Helper()
	connection, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if _, err := io.WriteString(connection, request); err != nil {
		t.Fatal(err)
	}
	_ = connection.SetReadDeadline(time.Now().Add(time.Second))
	response, err := http.ReadResponse(bufio.NewReader(connection), nil)
	if err != nil {
		t.Fatalf("no answer within a second: %v", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	return response.StatusCode, string(body)
}

func TestAToolCallWhoseBodyDoesNotArriveByTheDeadlineIsRefused(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{}`)
	sockets := guardedSockets(t, fleet, false, func(context.Context, string, io.ReadCloser) guard.Answer { return guard.Answer{} })
	sockets.options.GuardDeadline = 200 * time.Millisecond
	socket := opened(t, sockets)

	status, body := sent(t, socket, "POST /guard/check HTTP/1.1\r\nHost: ship\r\nContent-Length: 100\r\n\r\n{")

	if want := "Refused by the guard: guard failed: deadline.\n"; status != http.StatusForbidden || body != want {
		t.Fatalf("answer = %d %q, want 403 %q", status, body, want)
	}
}

// aDeadlineReachedAsTheAnswerIs is a context whose deadline has passed, its end seen only once the guard has answered, so the
// answer and the end are both ready when the check waits on them.
type aDeadlineReachedAsTheAnswerIs struct {
	context.Context
	answered chan struct{}
}

func (c aDeadlineReachedAsTheAnswerIs) Done() <-chan struct{} {
	<-c.answered
	time.Sleep(time.Millisecond)
	ended := make(chan struct{})
	close(ended)
	return ended
}

func (c aDeadlineReachedAsTheAnswerIs) Err() error { return context.DeadlineExceeded }

func TestAnAnswerReadyAsTheDeadlineIsReachedRefusesTheCall(t *testing.T) {
	for range 100 {
		answered := make(chan struct{})
		sockets := guardedSockets(t, aFleetAnswering(t, 200, "application/json", `{}`), false, func(context.Context, string, io.ReadCloser) guard.Answer {
			close(answered)
			return guard.Answer{}
		})
		ctx := aDeadlineReachedAsTheAnswerIs{Context: context.Background(), answered: answered}

		answer := sockets.guardAnswer(ctx, scout, []byte(aToolCall))

		if want := guard.Failed("deadline"); answer != want {
			t.Fatalf("answer = %+v, want %+v", answer, want)
		}
	}
}

// aCallOf is a tool call whose body is exactly size bytes.
func aCallOf(size int) string {
	return `{"tool_name":"Bash","tool_input":{"command":"` + strings.Repeat("x", size-len(`{"tool_name":"Bash","tool_input":{"command":""}}`)) + `"}}`
}

func TestAToolCallOfTheMostBytesASocketTakesIsChecked(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{}`)
	checked := 0
	socket := opened(t, guardedSockets(t, fleet, false, func(_ context.Context, _ string, input io.ReadCloser) guard.Answer {
		text, _ := io.ReadAll(input)
		checked = len(text)
		return guard.Answer{}
	}))

	response, body := post(t, socket, "/guard/check", aCallOf(MaxBytes))

	if response.StatusCode != 200 || checked != MaxBytes {
		t.Fatalf("answer = %d %q, checked %d bytes, want 200 and all %d checked", response.StatusCode, body, checked, MaxBytes)
	}
}

func TestAToolCallOneByteOverTheMostASocketTakesIsRefusedUnchecked(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{}`)
	isChecked := false
	socket := opened(t, guardedSockets(t, fleet, false, func(context.Context, string, io.ReadCloser) guard.Answer {
		isChecked = true
		return guard.Answer{}
	}))

	response, body := post(t, socket, "/guard/check", aCallOf(MaxBytes+1))

	if want := "Refused by the guard: guard failed: input too large.\n"; response.StatusCode != http.StatusForbidden || body != want || isChecked {
		t.Fatalf("answer = %d %q, checked %t, want 403 %q and no check", response.StatusCode, body, isChecked, want)
	}
}

func TestAToolCallWhoseBodyEndsBeforeItsLengthIsRefusedUnchecked(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{}`)
	isChecked := false
	socket := opened(t, guardedSockets(t, fleet, false, func(context.Context, string, io.ReadCloser) guard.Answer {
		isChecked = true
		return guard.Answer{}
	}))
	connection, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if _, err := io.WriteString(connection, "POST /guard/check HTTP/1.1\r\nHost: ship\r\nContent-Length: 100\r\n\r\n{"); err != nil {
		t.Fatal(err)
	}
	if err := connection.(*net.UnixConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	_ = connection.SetReadDeadline(time.Now().Add(time.Second))

	response, err := http.ReadResponse(bufio.NewReader(connection), nil)
	if err != nil {
		t.Fatalf("no answer within a second: %v", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)

	if want := "Refused by the guard: guard failed: input unreadable.\n"; response.StatusCode != http.StatusForbidden || string(body) != want || isChecked {
		t.Fatalf("answer = %d %q, checked %t, want 403 %q and no check", response.StatusCode, body, isChecked, want)
	}
}
