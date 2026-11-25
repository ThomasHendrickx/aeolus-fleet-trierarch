package shipsocket

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"time"

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
	body, err := readBy(ctx, w, r)
	switch {
	case errors.Is(err, os.ErrDeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded):
		answer = guard.Failed("deadline")
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
		// An answer ready as the deadline is reached is a late one.
		if ctx.Err() != nil {
			return guard.Failed("deadline")
		}
		return answer
	case <-ctx.Done():
		return guard.Failed("deadline")
	}
}

// readBy reads the call's body, at most MaxBytes and one more, by ctx's deadline: a body that does not arrive by then is no call. The
// connection keeps its deadline past a read that failed or left part of the body, so the server's own read of what is left cannot
// outwait it either.
func readBy(ctx context.Context, w http.ResponseWriter, r *http.Request) ([]byte, error) {
	deadline, ok := ctx.Deadline()
	if !ok {
		return nil, errors.New("no deadline")
	}
	connection := http.NewResponseController(w)
	if err := connection.SetReadDeadline(deadline); err != nil {
		return nil, err
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxBytes+1))
	if err != nil || len(body) > MaxBytes {
		return body, err
	}
	return body, connection.SetReadDeadline(time.Time{})
}
