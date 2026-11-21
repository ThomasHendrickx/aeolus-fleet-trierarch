package runpass

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

type keptEnd struct {
	ExitReason, SessionID, StartedAt, EndedAt string
	Lines                                     []struct{ Line string }
}

func anExitedSession(t *testing.T, beforeStop ...func(*aPass, string)) (*aPass, string, string, []byte, keptEnd) {
	t.Helper()
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
	if len(beforeStop) > 0 {
		p.sessions.beforeStop = func(id string) { beforeStop[0](p, id) }
	}
	p.sessions.observed = []sessions.Observed{{ShipID: scout, Status: "exited", ExitReason: "exit status 101 aeolus_ct_v1_scout"}}
	p.run(t)
	path := filepath.Join(at.Home, "ended", scout+".json")
	kept, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var end keptEnd
	if err := json.Unmarshal(kept, &end); err != nil {
		t.Fatal(err)
	}
	return p, folder, path, kept, end
}

func TestExitedSessionMasksEnd(t *testing.T) {
	_, _, _, kept, end := anExitedSession(t)
	if end.ExitReason != "exit status 101 [masked: crew token]" {
		t.Errorf("exit reason = %q, want masked exit status", end.ExitReason)
	}
	for _, secret := range []string{"aeolus_ct_v1_scout", "fake-end-secret"} {
		if strings.Contains(string(kept), secret) {
			t.Errorf("kept end contains %q, want masked", secret)
		}
	}
}

func TestExitedSessionKeepsLast200Lines(t *testing.T) {
	_, _, _, _, end := anExitedSession(t)
	if len(end.Lines) != 200 {
		t.Fatalf("line count = %d, want 200", len(end.Lines))
	}
	for i, want := range map[int]string{0: "line 002 [masked: crew token] [masked: secret variable END_SECRET]", 199: "line 201 [masked: crew token] [masked: secret variable END_SECRET]"} {
		if got := end.Lines[i].Line; got != want {
			t.Errorf("line %d = %q, want %q", i, got, want)
		}
	}
}

func TestExitedSessionKeepsSessionFacts(t *testing.T) {
	_, _, _, _, end := anExitedSession(t)
	if end.SessionID != "session-first" {
		t.Errorf("session ID = %q, want session-first", end.SessionID)
	}
	if end.StartedAt == "" || end.EndedAt == "" {
		t.Errorf("times = %q, %q, want both populated", end.StartedAt, end.EndedAt)
	}
}

func TestExitedSessionKeepsPrivateEnd(t *testing.T) {
	_, _, path, _, _ := anExitedSession(t)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0600 {
		t.Errorf("mode of %s = %o, want 600", path, got)
	}
}

func restartExitedSession(t *testing.T, p *aPass) {
	t.Helper()
	p.fleet.requests = []reconciler.Request{aRequest("restarting")}
	p.pass.Now = func() time.Time { return now.Add(5 * time.Second) }
	p.run(t)
}

func TestEndExistsBeforeHoldRemoval(t *testing.T) {
	called := false
	p, _, _, _, _ := anExitedSession(t, func(p *aPass, shipID string) {
		called = true
		if shipID != scout {
			t.Fatalf("stopping %s, want %s", shipID, scout)
		}
		path := filepath.Join(p.pass.Paths.Home, "ended", scout+".json")
		if _, err := os.Stat(path); err != nil {
			t.Errorf("stat end before stop = %v, want file", err)
		}
	})
	p.fleet.requests = []reconciler.Request{aRequest("releasing")}
	p.run(t)
	if !called {
		t.Fatal("stop called = false, want true")
	}
}

func TestEndIsKeptAcrossRestart(t *testing.T) {
	p, _, path, kept, _ := anExitedSession(t)
	restartExitedSession(t, p)
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(kept) {
		t.Errorf("end after restart = %s, want %s", after, kept)
	}
}

func TestNextEndReplacesPreviousEnd(t *testing.T) {
	p, _, path, _, _ := anExitedSession(t)
	restartExitedSession(t, p)
	p.fleet.requests = []reconciler.Request{aRequest("running")}
	p.sessions.observed = []sessions.Observed{{ShipID: scout, Status: "exited", ExitReason: "exit status 2"}}
	p.run(t)
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(after), "exit status 2") {
		t.Errorf("next end = %s, want exit status 2", after)
	}
}

func TestReleaseRemovesEnd(t *testing.T) {
	p, _, path, _, _ := anExitedSession(t)
	restartExitedSession(t, p)
	p.fleet.requests = []reconciler.Request{aRequest("releasing")}
	p.run(t)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("stat released end %s = %v, want not exist", path, err)
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
