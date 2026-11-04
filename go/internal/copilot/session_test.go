package copilot

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
)

func TestAStartIsCopilotWithTheFlagsJSONOutputEveryToolNoQuestionToolAndThePromptLast(t *testing.T) {
	for _, test := range []struct {
		name      string
		sessionID string
		want      []string
	}{
		{"a new session", "", []string{"copilot", "--model", "gpt-5", "--output-format=json", "--allow-all-tools", "--no-ask-user", "--prompt=--look"}},
		{"resuming a session", "copilot-1", []string{"copilot", "--model", "gpt-5", "--output-format=json", "--allow-all-tools", "--no-ask-user", "--resume=copilot-1", "--prompt=--look"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := CommandLine([]string{"--model", "gpt-5"}, "--look", test.sessionID); !slices.Equal(got, test.want) {
				t.Fatalf("CommandLine = %q, want %q", got, test.want)
			}
		})
	}
}

// logs are events captured from Copilot CLI 1.0.105, kept with today's trierarch's tests.
func logs(t *testing.T, name string) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "packages", "trierarch", "test", "logs", name)
}

func TestWhyAStartFailedIsTheErrorCopilotWroteOnStderr(t *testing.T) {
	for _, test := range []struct {
		log  string
		want string
	}{
		{"copilot-events-refused-model.jsonl", `Model "no-such-model" from --model flag is not available.`},
		{"copilot-events-no-login.jsonl", "Authentication failed (Request ID: E292:132E5:18CFA4D:1A2BF0B:6AE39552)"},
	} {
		t.Run(test.log, func(t *testing.T) {
			if got := ErrorIn(logs(t, test.log)); got != test.want {
				t.Fatalf("ErrorIn = %q, want %q", got, test.want)
			}
		})
	}
}

func TestWhyAModelCallFailedIsItsSessionError(t *testing.T) {
	events := filepath.Join(t.TempDir(), "events.jsonl")
	text := `{"type":"aeolus.stderr","line":"Error: an earlier one"}` + "\n" + `{"type":"session.error","data":{"message":"Execution failed: transport error"}}` + "\n" + `{"type":"aeolus.stderr","line":"a line that is no error"}` + "\n"
	if err := os.WriteFile(events, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}

	if got, want := ErrorIn(events), "Execution failed: transport error"; got != want {
		t.Fatalf("ErrorIn = %q, want %q", got, want)
	}
}

func TestTheSessionARestartResumesIsTheOneTheLastResultNamed(t *testing.T) {
	events := filepath.Join(t.TempDir(), "events.jsonl")
	text := `{"type":"result","sessionId":"copilot-1"}` + "\n" + `{"type":"assistant.message"}` + "\n" + `{"type":"result","sessionId":"copilot-2"}` + "\n" + `{"type":"aeolus.stderr","line":"Error: no"}` + "\n"
	if err := os.WriteFile(events, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}

	if got := LastSessionIn(events); got != "copilot-2" {
		t.Fatalf("LastSessionIn = %q, want copilot-2", got)
	}
	if got := LastSessionIn(filepath.Join(t.TempDir(), "none.jsonl")); got != "" {
		t.Fatalf("LastSessionIn with no events = %q, want none", got)
	}
}
