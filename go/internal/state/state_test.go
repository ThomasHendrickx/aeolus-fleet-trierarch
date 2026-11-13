package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
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
	saved.LowResources = []string{"memory", "disk"}
	saved.Entries[scout] = reconciler.Entry{ShipID: scout, State: "running", Harness: "claude-code", Exits: []string{}, Options: map[string]string{}, CrewToken: "aeolus_ct_v1_scout"}

	if err := file.Save(saved); err != nil {
		t.Fatal(err)
	}
	loaded, err := file.Load()

	if err != nil || loaded.Entries[scout].CrewToken != "aeolus_ct_v1_scout" || loaded.Entries[scout].State != "running" || !slices.Equal(loaded.LowResources, []string{"memory", "disk"}) {
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

func TestAnEntrySavedBeforeTheShipFolderLayoutIsReadAsTheMainOfAShipFolderMarkedToBeCrewedAgain(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	written := `{"entries":{"` + scout + `":{"shipId":"` + scout + `","settingsVersion":1,"harness":"claude-code","workspace":{"kind":"worktree","repository":"aeolus-fleet","ref":"main"},"options":{},"state":"running","since":"2026-11-04T10:00:00.000Z","exits":[],"folder":"/ships/` + scout + `/worktree","hasStarted":true}},"kept":[],"orphans":[],"refused":{}}`
	if err := os.WriteFile(path, []byte(written), 0o600); err != nil {
		t.Fatal(err)
	}

	loaded, err := File{Path: path}.Load()

	entry := loaded.Entries[scout]
	want := reconciler.Workspace{Kind: "repositories", Main: reconciler.RepositoryAt{Repository: "aeolus-fleet", Ref: "main"}}
	if err != nil || !reflect.DeepEqual(entry.Workspace, want) || !entry.IsOldLayout {
		t.Fatalf("entry %+v, %v, want the main of a ship folder of the old layout", entry, err)
	}
}

func TestAShipFolderWithNoSubRepositoryIsSavedWithItsEmptyListAndAFolderWithNoneAsTodaysTrierarchReadsThem(t *testing.T) {
	file := File{Path: filepath.Join(t.TempDir(), "state.json")}
	saved := reconciler.Empty()
	saved.Entries[scout] = reconciler.Entry{ShipID: scout, Workspace: reconciler.Workspace{Kind: "repositories", Main: reconciler.RepositoryAt{Repository: "aeolus-fleet"}}, Exits: []string{}, Options: map[string]string{}}
	saved.Entries["shp_notes"] = reconciler.Entry{ShipID: "shp_notes", Workspace: reconciler.Workspace{Kind: "folder", Name: "notes"}, Exits: []string{}, Options: map[string]string{}}

	if err := file.Save(saved); err != nil {
		t.Fatal(err)
	}
	var written struct {
		Entries map[string]struct {
			Workspace map[string]any `json:"workspace"`
		} `json:"entries"`
	}
	text, err := os.ReadFile(file.Path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(text, &written); err != nil {
		t.Fatal(err)
	}

	repositories, folder := written.Entries[scout].Workspace, written.Entries["shp_notes"].Workspace
	if subRepositories, ok := repositories["subRepositories"].([]any); !ok || len(subRepositories) != 0 {
		t.Fatalf("workspace %v, want an empty list of sub-repositories", repositories)
	}
	if !reflect.DeepEqual(folder, map[string]any{"kind": "folder", "name": "notes"}) {
		t.Fatalf("workspace %v, want the folder alone", folder)
	}
}
