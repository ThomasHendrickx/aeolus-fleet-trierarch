package shipsocket

import (
	"bytes"
	"context"
	"io"
	"net/http"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
)

// guardCheckPath is where the session's guard hook asks the host whether a tool call may run. The socket answers it itself, never the fleet.
const guardCheckPath = "/guard/check"

// checkGuard answers one tool call: 200 with no body when it may run, else 403 with the refusal as text, so a hook that runs the call
// only on a 200 fails closed on a refusal, on no answer and on a late one. Whatever goes wrong here refuses the call too.
func (s *Sockets) checkGuard(shipID string, w http.ResponseWriter, r *http.Request) {
	said := func(outcome string) { s.options.Log("guard check " + shipID + " " + outcome) }
	deadline := s.options.GuardDeadline
	if deadline <= 0 {
		deadline = guard.Deadline
	}
	ctx, cancel := context.WithTimeout(r.Context(), deadline)
	defer cancel()
	var answer guard.Answer
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxBytes+1))
	switch {
	case err != nil:
		answer = guard.Failed("input unreadable")
	case len(body) > MaxBytes:
		answer = guard.Failed("input too large")
	case s.options.GuardCheck == nil:
		answer = guard.Failed("no guard")
	default:
		answer = s.guardAnswer(ctx, shipID, body)
	}
	if answer.ExitCode == 0 {
		w.WriteHeader(http.StatusOK)
		said("allowed")
		return
	}
	if answer.ExitCode != 2 || answer.Stderr == "" {
		answer = guard.Failed("no answer")
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusForbidden)
	_, _ = io.WriteString(w, answer.Stderr)
	said("refused")
}

// guardAnswer is the guard's answer to the call by the deadline: a panic, or no answer by then, refuses it.
func (s *Sockets) guardAnswer(ctx context.Context, shipID string, body []byte) guard.Answer {
	answered := make(chan guard.Answer, 1)
	go func() {
		defer func() {
			if recover() != nil {
				answered <- guard.Failed("panic")
			}
		}()
		answered <- s.options.GuardCheck(ctx, shipID, io.NopCloser(bytes.NewReader(body)))
	}()
	select {
	case answer := <-answered:
		return answer
	case <-ctx.Done():
		return guard.Failed("deadline")
	}
}
