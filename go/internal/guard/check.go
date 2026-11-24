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

// defaultDeadline is guard check's own deadline, below the hook's timeout.
const defaultDeadline = 5 * time.Second

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
	return defaultDeadline
}

// Check reads the call from input and answers within the deadline. Anything
// that goes wrong refuses the call: the guard fails closed.
func (c Checker) Check(ctx context.Context, input io.Reader) Answer {
	bounded, cancel := context.WithTimeout(ctx, c.deadline())
	defer cancel()
	done := make(chan outcome, 1)
	go func() {
		defer func() {
			if recover() != nil {
				done <- outcome{refusal: failed("panic")}
			}
		}()
		done <- c.evaluate(bounded, input)
	}()
	var result outcome
	select {
	case result = <-done:
	case <-bounded.Done():
		result = outcome{refusal: failed("deadline")}
	}
	if result.refusal == nil {
		return Answer{}
	}
	return c.refuse(context.WithoutCancel(ctx), result)
}

func (c Checker) evaluate(ctx context.Context, input io.Reader) outcome {
	read, err := readCall(input)
	if err != nil {
		return outcome{refusal: failed("input unreadable")}
	}
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

func (c Checker) refuse(ctx context.Context, result outcome) Answer {
	refusal := Refusal{At: c.Now(), Tool: result.call.tool, Rule: result.refusal.rule, Summary: cut(result.call.summary(), summaryLength)}
	message := "Refused by the guard: " + result.refusal.rule + "."
	if set := result.refusal.set; set != nil {
		refusal.Set, refusal.Commit = &set.Name, &set.Commit
		message = fmt.Sprintf("Refused by the guard: %s, in %s @ %s.", result.refusal.rule, set.Name, cut(set.Commit, 7))
	}
	// The call is refused whether or not the record is kept: a guard that
	// cannot write its record still never lets the call through.
	_ = c.Refusals.Append(ctx, refusal)
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
