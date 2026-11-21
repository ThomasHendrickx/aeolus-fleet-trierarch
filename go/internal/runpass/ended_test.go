package runpass

import (
	"encoding/json"
	"fmt"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

func TestExitedSessionKeepsMaskedEndBeforeRestartAndReplacesOnlyAtNextEnd(t *testing.T) {
	p := aRunPass(t)
	p.crewed(t)
	at := paths.Of(t.TempDir(), "")
	p.pass.Paths = at
	data, err := json.Marshal(p.store.state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(at.Home, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(at.State, data, 0600); err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(at.Sessions, scout)
	if err := os.MkdirAll(folder, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "session-id"), []byte("session-first"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "secret-env.json"), []byte(`{"END_SECRET":"fake-end-secret"}`), 0600); err != nil {
		t.Fatal(err)
	}
	var events strings.Builder
	for i := 1; i <= 201; i++ {
		fmt.Fprintf(&events, "line %03d aeolus_ct_v1_scout fake-end-secret\n", i)
	}
	if err := os.WriteFile(filepath.Join(folder, "events.jsonl"), []byte(events.String()), 0600); err != nil {
		t.Fatal(err)
	}
	p.sessions.observed = []sessions.Observed{{ShipID: scout, Status: "exited", ExitReason: "exit status 101 aeolus_ct_v1_scout"}}
	p.run(t)
	path := filepath.Join(at.Home, "ended", scout+".json")
	kept, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var end struct {
		ExitReason, SessionID, StartedAt, EndedAt string
		Lines                                     []struct{ Line string }
	}
	if err := json.Unmarshal(kept, &end); err != nil {
		t.Fatal(err)
	}
	if end.ExitReason != "exit status 101 [masked: crew token]" || end.SessionID != "session-first" || end.StartedAt == "" || end.EndedAt == "" || len(end.Lines) != 200 || end.Lines[0].Line != "line 002 [masked: crew token] [masked: secret variable END_SECRET]" || end.Lines[199].Line != "line 201 [masked: crew token] [masked: secret variable END_SECRET]" || (strings.Contains(string(kept), "aeolus_ct_v1_scout") || strings.Contains(string(kept), "fake-end-secret")) {
		t.Fatalf("kept end = %s", kept)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("end mode: %v %v", info, err)
	}
	p.fleet.requests = []reconciler.Request{aRequest("restarting")}
	p.pass.Now = func() time.Time { return now.Add(5 * time.Second) }
	p.sessions.beforeStop = func(shipID string) {
		if shipID != scout {
			t.Fatalf("stopping %s, want %s", shipID, scout)
		}
		snapshot, err := os.ReadFile(path)
		if err != nil || string(snapshot) != string(kept) {
			t.Fatalf("evidence missing before hold removal: %v", err)
		}
		if err := os.RemoveAll(folder); err != nil {
			t.Fatal(err)
		}
	}
	p.run(t)
	p.sessions.beforeStop = nil
	after, err := os.ReadFile(path)
	if err != nil || string(after) != string(kept) {
		t.Fatalf("new start changed last end: %s, %v", after, err)
	}
	p.fleet.requests = []reconciler.Request{aRequest("running")}
	p.sessions.observed = []sessions.Observed{{ShipID: scout, Status: "exited", ExitReason: "exit status 2"}}
	p.run(t)
	after, err = os.ReadFile(path)
	if err != nil || !strings.Contains(string(after), "exit status 2") {
		t.Fatalf("next end not kept: %s, %v", after, err)
	}
	p.fleet.requests = []reconciler.Request{aRequest("releasing")}
	p.run(t)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("released end still exists: %v", err)
	}
}

func TestFailedEndWriteIsLoggedAndSessionStillRestarts(t *testing.T) {
	p := aRunPass(t)
	p.crewed(t)
	at := paths.Of(t.TempDir(), "")
	p.pass.Paths = at
	if err := os.MkdirAll(at.Home, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(at.Home, "ended"), []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	p.sessions.observed = []sessions.Observed{{ShipID: scout, Status: "exited", ExitReason: "exit status 1"}}
	p.run(t)
	if !strings.Contains(strings.Join(p.logged, "\n"), "keep last end") {
		t.Fatalf("missing end failure log: %q", p.logged)
	}
	p.fleet.requests = []reconciler.Request{aRequest("restarting")}
	p.pass.Now = func() time.Time { return now.Add(5 * time.Second) }
	p.run(t)
	if p.store.state.Entries[scout].State != "running" {
		t.Fatalf("restart state = %s", p.store.state.Entries[scout].State)
	}
}
