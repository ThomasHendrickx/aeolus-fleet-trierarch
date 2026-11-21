package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const aSeenPass = `{"passAt":"2026-11-20T13:02:28Z","ships":{"shp_one":{"inbox":{"waiting":2,"forced":1,"seenAt":"2026-11-20T13:02:25Z"},"turn":{"state":"busy","since":"2026-11-20T12:31:27Z","seenAt":"2026-11-20T13:02:27Z"}}}}`

func TestShipStatusShowsTheInboxAndTurnWithTheirOwnObservationAges(t *testing.T) {
	for _, state := range []string{"busy", "idle"} {
		t.Run(state, func(t *testing.T) {
			machine, at, _ := aRunningShipStatus(t)
			writeStatusFile(t, filepath.Join(at.Home, "seen.json"), strings.Replace(aSeenPass, "busy", state, 1))
			out, code := Main([]string{"status", "shp_one"}, machine)
			if code != 0 || !strings.Contains(out, "Turn: "+state+" since 2026-11-20T13:31:27+01:00, seen 4s ago\nActivity:") || !strings.Contains(out, "Inbox: 2 waiting, 1 forced, seen 6s ago\nProcesses:") {
				t.Fatalf("status = %d, %s", code, out)
			}
			out, code = Main([]string{"status", "shp_one", "--json"}, machine)
			var got struct {
				Session struct{ Turn any }
				Inbox   any
			}
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatal(err)
			}
			wantTurn := map[string]any{"state": state, "since": "2026-11-20T13:31:27+01:00", "seenAt": "2026-11-20T14:02:27+01:00"}
			wantInbox := map[string]any{"isWatched": true, "waiting": float64(2), "forced": float64(1), "seenAt": "2026-11-20T14:02:25+01:00"}
			if code != 0 || !reflect.DeepEqual(got.Session.Turn, wantTurn) || !reflect.DeepEqual(got.Inbox, wantInbox) {
				t.Fatalf("JSON = %s, want turn %v inbox %v", out, wantTurn, wantInbox)
			}
		})
	}
}

func TestShipStatusNeverTurnsAnUnwatchedInboxIntoZeroOrOldCounts(t *testing.T) {
	machine, at := aShipStatus(t)
	writeStatusFile(t, filepath.Join(at.Home, "seen.json"), aSeenPass)
	out, code := Main([]string{"status", "shp_one"}, machine)
	if code != 0 || !strings.Contains(out, "Inbox: not watched while no session runs") || strings.Contains(out, "2 waiting") || strings.Contains(out, "busy since") {
		t.Fatalf("status = %d, %s", code, out)
	}
	out, code = Main([]string{"status", "shp_one", "--json"}, machine)
	var got struct {
		Session struct{ Turn any }
		Inbox   map[string]any
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	if code != 0 || got.Session.Turn != nil || !reflect.DeepEqual(got.Inbox, map[string]any{"isWatched": false}) {
		t.Fatalf("JSON = %s, want null turn and unwatched inbox", out)
	}
}

func TestARunningSessionWithoutAnObservationSaysNotSeenYet(t *testing.T) {
	for _, snapshot := range []string{"missing", `{"passAt":"2026-11-20T13:02:28Z","ships":{}}`} {
		t.Run(snapshot, func(t *testing.T) {
			machine, at, _ := aRunningShipStatus(t)
			if snapshot == "missing" {
				if err := os.Remove(filepath.Join(at.Home, "seen.json")); err != nil {
					t.Fatal(err)
				}
			}
			if snapshot != "missing" {
				writeStatusFile(t, filepath.Join(at.Home, "seen.json"), snapshot)
			}
			out, code := Main([]string{"status", "shp_one"}, machine)
			if code != 0 || !strings.Contains(out, "Turn: unknown") || !strings.Contains(out, "Inbox: not seen yet") || strings.Contains(out, "0 waiting") || strings.Contains(out, "not watched") {
				t.Fatalf("status = %d, %s", code, out)
			}
			out, code = Main([]string{"status", "shp_one", "--json"}, machine)
			var got struct {
				Session struct{ Turn any }
				Inbox   any
			}
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatal(err)
			}
			if code != 0 || got.Session.Turn != nil || got.Inbox != nil {
				t.Fatalf("JSON = %s, want null turn and inbox", out)
			}
		})
	}
}

func TestAnUnreadableSnapshotLeavesTheOtherShipFactsAvailable(t *testing.T) {
	for _, content := range []string{"directory", `{"ships":`} {
		t.Run(content, func(t *testing.T) {
			machine, at, _ := aRunningShipStatus(t)
			path := filepath.Join(at.Home, "seen.json")
			if content == "directory" {
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			} else {
				writeStatusFile(t, path, content)
			}
			out, code := Main([]string{"status", "shp_one"}, machine)
			if code != 0 || !strings.Contains(out, "Turn: unreadable: "+path) || !strings.Contains(out, "Inbox: unreadable: "+path) || !strings.Contains(out, "Ship: design-tri-271c") || !strings.Contains(out, "Activity: tool Bash") {
				t.Fatalf("status = %d, %s", code, out)
			}
			out, code = Main([]string{"status", "shp_one", "--json"}, machine)
			var got struct {
				Inbox      any
				Unreadable []struct{ Path, Error string }
			}
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatal(err)
			}
			if code != 0 || got.Inbox != nil || len(got.Unreadable) != 1 || got.Unreadable[0].Path != path {
				t.Fatalf("JSON = %s", out)
			}
		})
	}
}

func TestARealZeroInboxIsWatchedAndKeepsItsObservationTime(t *testing.T) {
	machine, at, _ := aRunningShipStatus(t)
	writeStatusFile(t, filepath.Join(at.Home, "seen.json"), strings.ReplaceAll(strings.ReplaceAll(aSeenPass, `"waiting":2`, `"waiting":0`), `"forced":1`, `"forced":0`))
	out, code := Main([]string{"status", "shp_one"}, machine)
	if code != 0 || !strings.Contains(out, "Inbox: 0 waiting, 0 forced, seen 6s ago") {
		t.Fatalf("status = %d, %s", code, out)
	}
}
