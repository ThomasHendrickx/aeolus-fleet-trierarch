package codex

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
)

func TestAStartIsCodexExecWithTheFlagsTheJSONEventsNoQuestionToolAndThePromptLast(t *testing.T) {
	for _, test := range []struct {
		name         string
		isFirstStart bool
		want         []string
	}{
		{"a first start", true, []string{"codex", "exec", "-m", "gpt-5.6-terra", "--json", "--config=tools.experimental_request_user_input.enabled=false", "--", "--look"}},
		{"a restart, on the folder's last conversation", false, []string{"codex", "exec", "resume", "--last", "-m", "gpt-5.6-terra", "--json", "--config=tools.experimental_request_user_input.enabled=false", "--", "--look"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := CommandLine([]string{"-m", "gpt-5.6-terra", "--no-daemon"}, "--look", test.isFirstStart)

			if !slices.Equal(got, test.want) {
				t.Fatalf("CommandLine = %q, want %q", got, test.want)
			}
		})
	}
}

// logs are events captured from `codex exec --json`, kept with today's trierarch's tests.
func logs(t *testing.T, name string) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "packages", "trierarch", "test", "logs", name)
}

func TestWhyAStartFailedIsTheMessageOfCodexsLastErrorEvent(t *testing.T) {
	events := filepath.Join(t.TempDir(), "events.jsonl")
	text := `{"type":"thread.started","thread_id":"t-1"}` + "\n" + `{"type":"error","message":"stream disconnected"}` + "\n" + `{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}` + "\n"
	if err := os.WriteFile(events, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}

	if got, want := ErrorIn(events), "unexpected status 401 Unauthorized"; got != want {
		t.Fatalf("ErrorIn = %q, want %q", got, want)
	}
}

func TestAnAPIErrorCodexPassesOnIsSaidByItsOwnMessage(t *testing.T) {
	if got, want := ErrorIn(logs(t, "codex-events-refused.jsonl")), "The 'gpt-nonexistent-9' model is not supported when using Codex with a ChatGPT account."; got != want {
		t.Fatalf("ErrorIn = %q, want %q", got, want)
	}
}

func TestATurnThatAnsweredSaysNoError(t *testing.T) {
	if got := ErrorIn(logs(t, "codex-events-answered.jsonl")); got != "" {
		t.Fatalf("ErrorIn = %q, want none", got)
	}
}
