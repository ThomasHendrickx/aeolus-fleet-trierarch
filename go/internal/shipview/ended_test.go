package shipview

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestLastEndIsReadAfterHoldFilesGo(t *testing.T) {
	at, now := aView(t)
	path := filepath.Join(at.Home, "ended", "shp_one.json")
	raw := `{"endedAt":"2026-11-20T13:30:09Z","startedAt":"2026-11-20T13:12:40Z","exitReason":"exit status 1","harness":"codex","sessionId":"old-session","activity":{"kind":"error","at":"2026-11-20T13:30:09Z"},"lines":[{"at":"","kind":"error","line":"kept [masked: model proxy token]"}]}`
	writeFact(t, path, raw)
	view, err := Ship(at, "one", now)
	if err != nil {
		t.Fatal(err)
	}
	if view.LastEnd == nil {
		t.Fatal("last end = nil, want kept end")
	}
	if got := view.LastEnd.ExitReason; got != "exit status 1" {
		t.Errorf("exit reason = %q, want exit status 1", got)
	}
	if got := view.LastEnd.SessionID; got != "old-session" {
		t.Errorf("session ID = %q, want old-session", got)
	}
	if len(view.LastEnd.Lines) != 1 {
		t.Fatalf("lines = %v, want one line", view.LastEnd.Lines)
	}
	if got := view.LastEnd.Lines[0].Line; got != "kept [masked: model proxy token]" {
		t.Errorf("line = %q, want masked line", got)
	}
}

func TestUnreadableEndLeavesOtherFacts(t *testing.T) {
	for _, bad := range []string{"{", `{"lines":false}`} {
		t.Run(bad, func(t *testing.T) {
			at, now := aView(t)
			path := filepath.Join(at.Home, "ended", "shp_one.json")
			writeFact(t, path, bad)
			view, err := Ship(at, "one", now)
			if err != nil {
				t.Fatal(err)
			}
			if view.LastEnd != nil {
				t.Errorf("last end for %q = %+v, want nil", bad, view.LastEnd)
			}
			if view.ShipName != "one" {
				t.Errorf("ship name for %q = %q, want one", bad, view.ShipName)
			}
			if len(view.Unreadable) != 1 {
				t.Fatalf("unreadable for %q = %+v, want one entry", bad, view.Unreadable)
			}
			if got := view.Unreadable[0]; got.Fact != "last end" || got.Path != path {
				t.Errorf("unreadable for %q = %+v, want last end at %s", bad, got, path)
			}
		})
	}
}

func TestAbsentEndIsNullInJSON(t *testing.T) {
	at, now := aView(t)
	view, err := Ship(at, "one", now)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"lastEnd":null`) {
		t.Errorf("view JSON = %s, want lastEnd null", data)
	}
	if len(view.Unreadable) != 0 {
		t.Errorf("unreadable = %+v, want none", view.Unreadable)
	}
}
