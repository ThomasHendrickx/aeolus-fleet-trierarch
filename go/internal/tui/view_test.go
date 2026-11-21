package tui

import (
	"github.com/charmbracelet/lipgloss"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/seen"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/shipview"
)

func aScreen() Model {
	now := time.Date(2026, 11, 20, 14, 2, 31, 0, time.UTC)
	one := shipview.View{ShipID: "shp_one", ShipName: "design-tri-271c", Harness: "claude-code", State: "running", Since: "2026-11-20T13:30:12Z",
		Session: shipview.Session{Status: "running", Turn: &seen.Turn{State: "busy", Since: "2026-11-20T13:31:27Z", SeenAt: "2026-11-20T14:02:27Z"}, Activity: &shipview.Activity{Kind: "tool", Tool: "Bash", At: "2026-11-20T14:02:19Z"}, Processes: []shipview.Process{{PID: 48211, StartedAt: "2026-11-20T13:31:28Z", Command: "npm test --workspaces"}, {PID: 48230, StartedAt: "2026-11-20T13:31:29Z", Command: "node node_modules/.bin/vitest run"}}},
		Inbox:   &shipview.Inbox{IsWatched: true, Inbox: &seen.Inbox{Waiting: 2, Forced: 1, SeenAt: "2026-11-20T14:02:27Z"}},
		Places:  shipview.Places{ShipFolder: "/ships/shp_one", Main: "/ships/shp_one/main", Home: "/ships/shp_one/home", Hold: "/sessions/shp_one", Events: "/sessions/shp_one/events.jsonl"},
		Lines:   []shipview.Line{{At: "2026-11-20T13:31:25Z", Kind: "text", Line: `{"type":"assistant","text":"Running tests"}`}, {At: "2026-11-20T13:31:27Z", Kind: "tool", Tool: "Bash", Line: `{"command":"AEOLUS_TOKEN=[masked: crew token] npm test"}`}, {Kind: "result", Line: `{"result":"no timestamp"}`}},
	}
	rows := []shipview.View{one,
		{ShipID: "shp_two", ShipName: "build-api-12", Harness: "codex", State: "running", Session: shipview.Session{Status: "running", Turn: &seen.Turn{State: "idle", Since: "2026-11-20T14:00:31Z"}, Activity: &shipview.Activity{Kind: "result", At: "2026-11-20T14:00:31Z"}}, Inbox: &shipview.Inbox{IsWatched: true, Inbox: &seen.Inbox{}}},
		{ShipID: "shp_three", ShipName: "release-bot", Harness: "claude-code", State: "crewing", Session: shipview.Session{Status: "running", Turn: &seen.Turn{State: "busy", Since: "2026-11-20T14:02:11Z"}, Activity: &shipview.Activity{Kind: "text", At: "2026-11-20T14:02:28Z"}}, Inbox: &shipview.Inbox{IsWatched: true, Inbox: &seen.Inbox{}}},
		{ShipID: "shp_four", ShipName: "review-88", Harness: "claude-code", State: "restarting", Restarts: 2, Inbox: &shipview.Inbox{}},
		{ShipID: "shp_five", ShipName: "docs-writer", Harness: "codex", State: "crashed", Restarts: 3, Inbox: &shipview.Inbox{}},
	}
	return Model{machine: shipview.Machine{Ships: rows, PassAt: "2026-11-20T14:02:27Z"}, ship: one, now: now, width: 120, height: 40}
}

// The layout may pad columns; every screen's complete words and row order are fixed here.
func screenWords(text string) string {
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		if strings.Trim(line, " ─") == "" {
			continue
		}
		lines = append(lines, strings.Join(strings.Fields(line), " "))
	}
	return strings.Join(lines, "\n")
}

func TestListViewMatchesTheApprovedScreen(t *testing.T) {
	m := aScreen()
	want := `aeolus-trierarch 5 ships, 3 sessions running
SHIP STATE HARNESS TURN ACTIVITY INBOX RESTARTS
> design-tri-271c running claude-code busy 31m tool Bash, 12s ago 2, 1 forced 0
build-api-12 running codex idle 2m result, 2m ago 0 0
release-bot crewing claude-code busy 20s text, 3s ago 0 0
review-88 restarting claude-code - - not watched 2
docs-writer crashed codex - - not watched 3
up/down move enter open e last end q quit read 14:02:31, pass 4s ago
To act on a ship: a forced message, Restart or Edit… in the console`
	if got := screenWords(m.View()); got != want {
		t.Fatalf("View(list) =\n%s\nwant\n%s", got, want)
	}
}

func TestShipViewMatchesTheApprovedScreen(t *testing.T) {
	m := aScreen()
	m.screen = shipScreen
	want := `aeolus-trierarch > design-tri-271c read 14:02:31
Ship design-tri-271c (shp_one), claude-code, on the host
State running since 13:30:12, 0 restarts
Turn busy since 13:31:27 (31m), seen 4s ago
Activity tool Bash, 12s ago
Inbox 2 waiting, 1 forced, seen 4s ago
Processes pid 48211 31m npm test --workspaces
pid 48230 31m node node_modules/.bin/vitest run
Last end none kept: no session of this ship ended since it was crewed here
Places ship folder /ships/shp_one
main /ships/shp_one/main
home /ships/shp_one/home
hold /sessions/shp_one
events /sessions/shp_one/events.jsonl
Last lines of events.jsonl up/down scroll
13:31:25 text {"type":"assistant","text":"Running tests"}
13:31:27 tool Bash {"command":"AEOLUS_TOKEN=[masked: crew token] npm test"}
--:--:-- result {"result":"no timestamp"}
esc back e last end q quit
To act on design-tri-271c: a forced message, Restart or Edit… in the console`
	if got := screenWords(m.View()); got != want {
		t.Fatalf("View(ship) =\n%s\nwant\n%s", got, want)
	}
}

func TestViewCutsWholeMaskedLinesToTerminalWidth(t *testing.T) {
	m := aScreen()
	m.screen = shipScreen
	m.width = 70
	m.ship.Lines = []shipview.Line{{Kind: "tool", Tool: "Bash", Line: `{"command":"[masked: crew token] ` + strings.Repeat("界", 100) + `"}`}}
	got := m.View()
	if !strings.Contains(got, "[masked: crew token]") || !strings.Contains(got, "…") {
		t.Fatalf("View(long masked line) = %s, want masked value and ellipsis", got)
	}
	for _, line := range strings.Split(got, "\n") {
		if lipgloss.Width(line) > 70 {
			t.Fatalf("View(width 70) line width = %d, want <=70: %q", lipgloss.Width(line), line)
		}
	}
}

func TestListViewShowsEmptyAndUnreadableStates(t *testing.T) {
	for _, test := range []struct {
		name    string
		failure string
		want    string
	}{{"empty", "", "No ship is crewed here."}, {"unreadable", "cannot read the state at /state.json: permission denied", "cannot read the state at /state.json: permission denied"}} {
		t.Run(test.name, func(t *testing.T) {
			m := aScreen()
			m.machine.Ships = nil
			m.failure = test.failure
			if got := m.View(); !strings.Contains(got, test.want) {
				t.Fatalf("View(%s) = %s, want %s", test.name, got, test.want)
			}
		})
	}
}

func TestShipViewShowsPartialAndMaskingFailures(t *testing.T) {
	m := aScreen()
	m.screen = shipScreen
	m.ship.Unreadable = []shipview.Unreadable{{Fact: "processes", Path: "/proc/48211/cwd", Error: "permission denied"}, {Fact: "masking", Path: "/secret-env.json", Error: "permission denied"}, {Fact: "seen", Path: "/seen.json", Error: "unexpected end of JSON input"}}
	m.ship.Lines = nil
	got := m.View()
	for _, want := range []string{"unreadable: /proc/48211/cwd: permission denied", "not shown: cannot read /secret-env.json to mask it (permission denied)", "unreadable: /seen.json: unexpected end of JSON input", "Ship"} {
		if !strings.Contains(got, want) {
			t.Fatalf("View(partial) = %s, want %q", got, want)
		}
	}
}
