package shipsocket

import (
	"context"
	"io"
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
