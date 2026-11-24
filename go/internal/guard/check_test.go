package guard

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestACallNoRuleRefusesRunsWithoutAnAnswer(t *testing.T) {
	checker, refusals := aChecker(aSet("no-web", "8d41e07aa", `{"tools":{"deny":["web"]}}`))

	allowed(t, checker, aCall("Read", map[string]any{"file_path": repository + "/README.md"}))
	if len(refusals.refusals) != 0 {
		t.Errorf("an allowed call recorded %v, want no refusal", refusals.refusals)
	}
}

func TestARefusalNamesTheRuleTheSetAndItsShortCommit(t *testing.T) {
	checker, _ := aChecker(aSet("no-web", "8d41e07aa1b2", `{"tools":{"deny":["web"]}}`))

	refusedAs(t, checker, aCall("WebFetch", map[string]any{"url": "https://example.com"}), "Refused by the guard: tools.deny web, in no-web @ 8d41e07.")
}

func TestARefusalIsRecordedWithTheRuleSetCommitAndTheCallCutTo200Characters(t *testing.T) {
	checker, refusals := aChecker(aSet("no-web", "8d41e07aa1b2", `{"tools":{"deny":["web"]}}`))
	url := "https://example.com/" + strings.Repeat("x", 300)

	check(t, checker, aCall("WebFetch", map[string]any{"url": url}))

	set, commit := "no-web", "8d41e07aa1b2"
	want := Refusal{At: checkedAt, Tool: "WebFetch", Rule: "tools.deny web", Set: &set, Commit: &commit, Summary: (`{"url":"` + url)[:200]}
	if len(refusals.refusals) != 1 || !sameRefusal(refusals.refusals[0], want) {
		t.Errorf("recorded %+v, want %+v", refusals.refusals, want)
	}
}

func TestARefusalByTheMechanismRecordsNoSetAndNoCommit(t *testing.T) {
	checker, refusals := aChecker()
	checker.Sets = memorySets{err: errors.New("rules.json: permission denied")}

	check(t, checker, aShellCall("ls"))

	if len(refusals.refusals) != 1 {
		t.Fatalf("recorded %v, want one refusal", refusals.refusals)
	}
	encoded, err := json.Marshal(refusals.refusals[0])
	if err != nil {
		t.Fatal(err)
	}
	want := `{"at":"2026-11-24T21:00:00Z","tool":"Bash","rule":"guard failed: rules unreadable","set":null,"commit":null,"summary":"ls"}`
	if string(encoded) != want {
		t.Errorf("recorded %s, want %s", encoded, want)
	}
}

func TestTheGuardFailsClosed(t *testing.T) {
	tests := []struct {
		name, call, want string
		sets             SetSource
	}{
		{"on input it cannot read", "not json", "Refused by the guard: guard failed: input unreadable.", nil},
		{"on input without a tool", `{"tool_input":{}}`, "Refused by the guard: guard failed: input unreadable.", nil},
		{"on rules it cannot read", aShellCall("ls"), "Refused by the guard: guard failed: rules unreadable.", memorySets{err: errors.New("gone")}},
		{"on rules it cannot decode", aShellCall("ls"), "Refused by the guard: guard failed: rules unreadable.", memorySets{sets: []json.RawMessage{json.RawMessage(`{"name":1}`)}}},
		{"on a rule type it does not know", aShellCall("ls"), "Refused by the guard: guard failed: rules unreadable.", memorySets{sets: []json.RawMessage{aSet("odd", "abc", `{"reads":{"deny":["x"]}}`)}}},
		{"on a command it cannot parse", aShellCall("echo 'unterminated"), "Refused by the guard: guard failed: shell input unparsable.", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			checker, _ := aChecker()
			if tt.sets != nil {
				checker.Sets = tt.sets
			}
			refusedAs(t, checker, tt.call, tt.want)
		})
	}
}

// panickingSets stands for a check that breaks while it runs.
type panickingSets struct{}

func (panickingSets) Sets(context.Context) ([]json.RawMessage, error) { panic("broken") }

func TestTheGuardFailsClosedOnAPanic(t *testing.T) {
	checker, _ := aChecker()
	checker.Sets = panickingSets{}

	refusedAs(t, checker, aShellCall("ls"), "Refused by the guard: guard failed: panic.")
}

// blockingSets never answers until released.
type blockingSets struct{ release chan struct{} }

func (b blockingSets) Sets(context.Context) ([]json.RawMessage, error) {
	<-b.release
	return nil, nil
}

func TestTheGuardRefusesAtItsOwnDeadline(t *testing.T) {
	checker, _ := aChecker()
	sets := blockingSets{release: make(chan struct{})}
	t.Cleanup(func() { close(sets.release) })
	checker.Sets = sets
	checker.Deadline = 20 * time.Millisecond

	refusedAs(t, checker, aShellCall("ls"), "Refused by the guard: guard failed: deadline.")
}

func TestTheDeadlineIsFiveSecondsUnlessSet(t *testing.T) {
	if got := (Checker{}).deadline(); got != 5*time.Second {
		t.Errorf("deadline() = %v, want 5s", got)
	}
}

func sameRefusal(got, want Refusal) bool {
	return got.At.Equal(want.At) && got.Tool == want.Tool && got.Rule == want.Rule &&
		equalPointer(got.Set, want.Set) && equalPointer(got.Commit, want.Commit) && got.Summary == want.Summary
}

func equalPointer(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
