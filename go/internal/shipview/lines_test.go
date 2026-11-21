package shipview

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mask"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLastLinesUseEachHarnessReadingAndKeepUnrecognizedLines(t *testing.T) {
	for _, example := range []struct{ harness, event, kind, tool string }{
		{"claude-code", `{"timestamp":"2026-11-20T13:31:27Z","type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}`, "tool", "Bash"},
		{"codex", `{"timestamp":"2026-11-20T13:31:27Z","type":"item.started","item":{"type":"command_execution"}}`, "tool", "command_execution"},
		{"copilot", `{"timestamp":"2026-11-20T13:31:27Z","type":"tool.execution_start","data":{"toolName":"shell"}}`, "tool", "shell"},
	} {
		t.Run(example.harness, func(t *testing.T) {
			at, now := aView(t)
			keep := fmt.Sprintf(`{"entries":{"shp_one":{"shipId":"shp_one","shipName":"one","harness":%q,"crewToken":"fake-token"}}}`, example.harness)
			writeFact(t, at.State, keep)
			writeFact(t, filepath.Join(at.Sessions, "shp_one", "events.jsonl"), example.event+"\nraw diagnostic fake-token\n\n")
			view, err := Ship(at, "one", now)
			if err != nil {
				t.Fatal(err)
			}
			want := []Line{{At: "2026-11-20T13:31:27Z", Kind: example.kind, Tool: example.tool, Line: example.event}, {Line: "raw diagnostic [masked: crew token]"}, {}}
			if !reflect.DeepEqual(view.Lines, want) {
				t.Fatalf("Ship(events %q) lines = %+v, want %+v", example.event+"\nraw diagnostic fake-token\n\n", view.Lines, want)
			}
		})
	}
}

func TestLastLinesKeepExactlyTwoHundredWholeMaskedLinesInOrder(t *testing.T) {
	for _, count := range []int{0, 199, 200, 201} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			at, now := aView(t)
			var events strings.Builder
			for n := 1; n <= count; n++ {
				fmt.Fprintf(&events, "line %03d SECRET-CREW-TOKEN %s\n", n, strings.Repeat("wide", 1000))
			}
			writeFact(t, filepath.Join(at.Sessions, "shp_one", "events.jsonl"), events.String())
			view, err := Ship(at, "one", now)
			if err != nil {
				t.Fatal(err)
			}
			if len(view.Lines) != min(count, 200) {
				t.Fatalf("Ship(%d events) line count = %d, want %d", count, len(view.Lines), min(count, 200))
			}
			for i, line := range view.Lines {
				want := fmt.Sprintf("line %03d [masked: crew token] %s", max(1, count-199)+i, strings.Repeat("wide", 1000))
				if line.Line != want {
					t.Fatalf("Ship(%d events) line %d = %q, want %q", count, i, line.Line, want)
				}
			}
		})
	}
}

func TestUnreadableCredentialsSuppressLinesAndNameTheirSourceInJSON(t *testing.T) {
	at, now := aView(t)
	writeFact(t, filepath.Join(at.Sessions, "shp_one", "events.jsonl"), `{"type":"item.started","item":{"type":"command_execution"},"text":"fake-value"}`)
	for _, path := range []string{at.ModelToken, filepath.Join(at.Sessions, "another", "secret-env.json")} {
		if strings.Contains(path, "another") {
			writeFact(t, path, `{}`)
		}
		view, err := (Reader{Files: filesOnDisk{denied: path}}).Ship(context.Background(), at, "one", now)
		if err != nil || len(view.Lines) != 0 || view.Session.Activity == nil || len(view.Unreadable) != 1 || view.Unreadable[0].Path != path || !strings.Contains(view.Unreadable[0].Error, "permission denied") {
			t.Fatalf("Ship(denied %q) = (%+v, %v), want no lines, activity, one permission denied source and nil error", path, view, err)
		}
		data, _ := json.Marshal(view)
		if strings.Contains(string(data), "fake-value") {
			t.Fatalf("Ship(denied %q) JSON = %s, want no fake-value", path, data)
		}
	}
}

func TestCancelledEventReadingRecordsTheReasonWithoutLines(t *testing.T) {
	at, now := aView(t)
	path := filepath.Join(at.Sessions, "shp_one", "events.jsonl")
	writeFact(t, path, "fake-event")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var view View
	view.readEvents(ctx, filesOnDisk{}, path, nil, mask.Masker{}, now)
	if len(view.Lines) != 0 || len(view.Unreadable) != 1 || view.Unreadable[0].Error != context.Canceled.Error() {
		t.Fatalf("readEvents(cancelled, %q) = %+v, want no lines and one context canceled reason", path, view)
	}
}
func TestCancelledMaskingRecordsTheReasonOnce(t *testing.T) {
	at, now := aView(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	view, err := (Reader{}).Ship(ctx, at, "one", now)
	if err != nil {
		t.Fatal(err)
	}
	var reasons []Unreadable
	for _, failure := range view.Unreadable {
		if failure.Fact == "masking" {
			reasons = append(reasons, failure)
		}
	}
	if len(reasons) != 1 || reasons[0].Error != context.Canceled.Error() || len(view.Lines) != 0 || len(view.Session.Processes) != 0 {
		t.Fatalf("Ship(cancelled, %q) = %+v, want hidden content and one context canceled masking reason", at.Home, view)
	}
}
