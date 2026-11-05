package activity

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// readsLines reads a line "tool:Bash" as a tool call, "text" as text and any other line as no activity.
func readsLines(line string) (Reading, bool) {
	switch {
	case strings.HasPrefix(line, "tool:"):
		return Reading{Kind: "tool", Tool: strings.TrimPrefix(line, "tool:")}, true
	case line == "text":
		return Reading{Kind: "text"}, true
	}
	return Reading{}, false
}

func TestTheLatestEventThatReadsAsActivityIsTheActivity(t *testing.T) {
	got, ok := Latest([]string{"tool:Bash", "text", "noise", "garbage"}, readsLines)

	if !ok || got != (Reading{Kind: "text"}) {
		t.Fatalf("Latest = %+v, %v, want text", got, ok)
	}
}

func TestEventsThatShowNoActivityAreNoActivity(t *testing.T) {
	if got, ok := Latest([]string{"noise"}, readsLines); ok {
		t.Fatalf("Latest = %+v, want none", got)
	}
	if got, ok := Latest(nil, readsLines); ok {
		t.Fatalf("Latest of no events = %+v, want none", got)
	}
}

func TestAnActivityIsAtWhenTheEventsFileWasLastWritten(t *testing.T) {
	events := filepath.Join(t.TempDir(), "events.jsonl")
	if err := os.WriteFile(events, []byte("text\ntool:Bash\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	wrote := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	if err := os.Chtimes(events, wrote, wrote); err != nil {
		t.Fatal(err)
	}

	got, ok := Of(events, readsLines)

	if want := (Activity{At: wrote, Kind: "tool", Tool: "Bash"}); !ok || !got.At.Equal(want.At) || got.Kind != want.Kind || got.Tool != want.Tool {
		t.Fatalf("Of = %+v, %v, want %+v", got, ok, want)
	}
}

func TestOnlyTheLast200EventsAreRead(t *testing.T) {
	events := filepath.Join(t.TempDir(), "events.jsonl")
	text := "text\n" + strings.Repeat("noise\n", 200)
	if err := os.WriteFile(events, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}

	if got, ok := Of(events, readsLines); ok {
		t.Fatalf("Of = %+v, want none: the one activity is 201 lines back", got)
	}
}

func TestASessionThatWroteNoEventsFileHasNoActivity(t *testing.T) {
	if got, ok := Of(filepath.Join(t.TempDir(), "missing.jsonl"), readsLines); ok {
		t.Fatalf("Of = %+v, want none", got)
	}
}
