// Package guard is guard check: it reads one tool call of a guarded session
// and refuses it when the guard's own protection or a rule set forbids it,
// as aeolus-fleet docs/design/guard section 4.6 specifies.
package guard

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"
	"unicode/utf8"
)

// Deadline is guard check's own deadline, below the hook's timeout.
const Deadline = 5 * time.Second

// summaryLength is how much of the call a refusal record keeps.
const summaryLength = 200

// SetSource reads the rule sets kept for the session, each an entry of the
// rules message's sets.
type SetSource interface {
	Sets(ctx context.Context) ([]json.RawMessage, error)
}

// Links reads a symbolic link: its target, or false when path is no link
// (also when it does not exist).
type Links interface {
	Readlink(ctx context.Context, path string) (target string, isLink bool, err error)
}

// RefusalLog keeps each refusal.
type RefusalLog interface {
	Append(ctx context.Context, refusal Refusal) error
}

// Boundary is where a guarded session may write: the ship's folder and the
// repositories its crew settings name, absolute.
type Boundary struct {
	ShipFolder   string
	Repositories []string
}

// Checker checks one tool call.
type Checker struct {
	Sets     SetSource
	Links    Links
	Refusals RefusalLog
	Now      func() time.Time
	// Home is the session's home folder, for ~ in shell words.
	Home     string
	Boundary Boundary
	// Protected are absolute globs of the guard's own files, its rules and
	// the harness's settings: no call writes them, whatever the rules.
	Protected []string
	// Deadline is guard check's own deadline; zero means five seconds.
	Deadline time.Duration
}

// Answer is what the hook prints and exits with.
type Answer struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// Refusal is one refusal as the guard records it. Set and Commit are nil for a
// refusal by the mechanism itself.
type Refusal struct {
	At      time.Time `json:"at"`
	Tool    string    `json:"tool"`
	Rule    string    `json:"rule"`
	Set     *string   `json:"set"`
	Commit  *string   `json:"commit"`
	Summary string    `json:"summary"`
}

// verdict is a refusal before it is answered: the rule and the set it is in,
// no set for the mechanism's own.
type verdict struct {
	rule string
	set  *Set
}

func mechanism(rule string) *verdict { return &verdict{rule: rule} }

func failed(cause string) *verdict { return mechanism("guard failed: " + cause) }

// outcome is the call as read and the verdict on it, nil when it runs.
type outcome struct {
	call    call
	refusal *verdict
}

func (c Checker) deadline() time.Duration {
	if c.Deadline > 0 {
		return c.Deadline
	}
	return Deadline
}

// Check reads the call from input and answers within the deadline. Anything
// that goes wrong refuses the call: the guard fails closed. Recording a
// refusal runs within the same deadline and recovery, so a refusal it cannot
// record is refused as guard failed. Check reads input itself and closes it
// at the deadline, so a read that stalls stops there.
func (c Checker) Check(ctx context.Context, input io.ReadCloser) Answer {
	bounded, cancel := context.WithTimeout(ctx, c.deadline())
	defer cancel()
	context.AfterFunc(bounded, func() { _ = input.Close() })
	read, cause := readWithin(bounded, input)
	var result outcome
	if cause == "" {
		result, cause = guarded(bounded, func() outcome { return c.evaluate(bounded, read) })
	}
	if cause != "" {
		result = outcome{refusal: failed(cause)}
	}
	if result.refusal == nil {
		return Answer{}
	}
	if bounded.Err() != nil {
		return deny(failed("deadline"))
	}
	err, cause := guarded(bounded, func() error { return c.Refusals.Append(bounded, c.record(result)) })
	if cause == "" && err != nil {
		cause = "refusal unrecorded"
	}
	if cause != "" {
		return deny(failed(cause))
	}
	return deny(result.refusal)
}

// readWithin reads the call from input in the caller, which closes input at
// ctx's deadline. The cause is why it read no call, "" when it did.
func readWithin(ctx context.Context, input io.Reader) (read call, cause string) {
	defer func() {
		if recover() != nil {
			read, cause = call{}, "panic"
		}
	}()
	read, err := readCall(input)
	switch {
	case ctx.Err() != nil:
		return call{}, "deadline"
	case err != nil:
		return call{}, "input unreadable"
	}
	return read, ""
}

// guarded runs step within ctx's deadline and its own panic recovery. The
// cause is why it gave no result, "" when it did.
func guarded[T any](ctx context.Context, step func() T) (T, string) {
	type ended struct {
		result T
		cause  string
	}
	done := make(chan ended, 1)
	go func() {
		defer func() {
			if recover() != nil {
				done <- ended{cause: "panic"}
			}
		}()
		done <- ended{result: step()}
	}()
	select {
	case end := <-done:
		return end.result, end.cause
	case <-ctx.Done():
		var none T
		return none, "deadline"
	}
}

func (c Checker) evaluate(ctx context.Context, read call) outcome {
	raw, err := c.Sets.Sets(ctx)
	if err != nil {
		return outcome{call: read, refusal: failed("rules unreadable")}
	}
	sets, err := decodeSets(raw)
	if err != nil {
		return outcome{call: read, refusal: failed("rules unreadable")}
	}
	if ctx.Err() != nil {
		return outcome{call: read, refusal: failed("deadline")}
	}
	return outcome{call: read, refusal: c.judge(ctx, read, sets)}
}

// record is the refusal as the guard keeps it.
func (c Checker) record(result outcome) Refusal {
	refusal := Refusal{At: c.Now(), Tool: result.call.tool, Rule: result.refusal.rule, Summary: cut(result.call.summary(), summaryLength)}
	if set := result.refusal.set; set != nil {
		refusal.Set, refusal.Commit = &set.Name, &set.Commit
	}
	return refusal
}

// Failed is the answer that refuses a call guard check could not check, as
// guard failed with the cause: before a Checker can run, it fails closed too.
func Failed(cause string) Answer { return deny(failed(cause)) }

// deny is the answer that refuses the call for the verdict.
func deny(refusal *verdict) Answer {
	message := "Refused by the guard: " + refusal.rule + "."
	if set := refusal.set; set != nil {
		message = fmt.Sprintf("Refused by the guard: %s, in %s @ %s.", refusal.rule, set.Name, cut(set.Commit, 7))
	}
	decision, err := json.Marshal(map[string]any{"hookSpecificOutput": map[string]string{
		"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": message,
	}})
	if err != nil {
		decision = nil
	}
	return Answer{Stdout: string(decision), Stderr: message + "\n", ExitCode: 2}
}

// cut keeps at most n characters of text.
func cut(text string, n int) string {
	if utf8.RuneCountInString(text) <= n {
		return text
	}
	return string([]rune(text)[:n])
}
