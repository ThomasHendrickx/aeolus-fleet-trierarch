package shipview

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLastEndIsReadAfterHoldFilesGoAndUnreadableEndLeavesOtherFacts(t *testing.T) {
	at, now := aView(t)
	path := filepath.Join(at.Home, "ended", "shp_one.json")
	raw := `{"endedAt":"2026-11-20T13:30:09Z","startedAt":"2026-11-20T13:12:40Z","exitReason":"exit status 1","harness":"codex","sessionId":"old-session","activity":{"kind":"error","at":"2026-11-20T13:30:09Z"},"lines":[{"at":"","kind":"error","line":"kept [masked: model proxy token]"}]}`
	writeFact(t, path, raw)
	view, err := Ship(at, "one", now)
	if err != nil || view.LastEnd == nil || view.LastEnd.ExitReason != "exit status 1" || view.LastEnd.SessionID != "old-session" || len(view.LastEnd.Lines) != 1 || view.LastEnd.Lines[0].Line != "kept [masked: model proxy token]" {
		t.Fatalf("last end = %+v, %v", view, err)
	}
	for _, bad := range []string{"{", `{"lines":false}`} {
		writeFact(t, path, bad)
		view, err = Ship(at, "one", now)
		if err != nil || view.LastEnd != nil || view.ShipName != "one" || len(view.Unreadable) != 1 || view.Unreadable[0].Fact != "last end" || view.Unreadable[0].Path != path {
			t.Fatalf("bad end %q: %+v, %v", bad, view, err)
		}
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	view, err = Ship(at, "one", now)
	data, _ := json.Marshal(view)
	if err != nil || !strings.Contains(string(data), `"lastEnd":null`) || len(view.Unreadable) != 0 {
		t.Fatalf("absent end JSON = %s, %v", data, err)
	}
}
