package state

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

const scout = "shp_01m6jyczpnpp5c0vxh54c966cy"

func TestNoStateFileIsTheEmptyState(t *testing.T) {
	state, err := File{Path: filepath.Join(t.TempDir(), "state.json")}.Load()

	if err != nil || len(state.Entries) != 0 || state.Kept == nil || state.Refused == nil {
		t.Fatalf("state %+v, %v", state, err)
	}
}

func TestASavedStateIsLoadedAsItWasSaved(t *testing.T) {
	file := File{Path: filepath.Join(t.TempDir(), "state.json")}
	saved := reconciler.Empty()
	saved.Entries[scout] = reconciler.Entry{ShipID: scout, State: "running", Harness: "claude-code", Exits: []string{}, Options: map[string]string{}, CrewToken: "aeolus_ct_v1_scout"}

	if err := file.Save(saved); err != nil {
		t.Fatal(err)
	}
	loaded, err := file.Load()

	if err != nil || loaded.Entries[scout].CrewToken != "aeolus_ct_v1_scout" || loaded.Entries[scout].State != "running" {
		t.Fatalf("loaded %+v, %v", loaded, err)
	}
}

func TestTheStateIsReadableByItsUserOnly(t *testing.T) {
	file := File{Path: filepath.Join(t.TempDir(), "state.json")}

	if err := file.Save(reconciler.Empty()); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(file.Path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v, %v", info.Mode(), err)
	}
}

func TestTodaysTrierarchsStateIsRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	written := `{"entries":{"` + scout + `":{"shipId":"` + scout + `","shipName":"scout","settingsVersion":1,"harness":"claude-code","workspace":{"kind":"worktree","repository":"aeolus-fleet"},"options":{},"state":"running","since":"2026-11-04T10:00:00.000Z","exits":["2026-11-04T09:59:00.000Z"],"folder":"/w/aeolus-fleet/scout","crewToken":"aeolus_ct_v1_scout","hasStarted":true,"login":"subscription"}},"kept":[],"orphans":[],"refused":{}}`
	if err := os.WriteFile(path, []byte(written), 0o600); err != nil {
		t.Fatal(err)
	}

	loaded, err := File{Path: path}.Load()

	entry := loaded.Entries[scout]
	if err != nil || entry.ShipName != "scout" || len(entry.Exits) != 1 || entry.Folder != "/w/aeolus-fleet/scout" || !entry.HasStarted {
		t.Fatalf("entry %+v, %v", entry, err)
	}
}
