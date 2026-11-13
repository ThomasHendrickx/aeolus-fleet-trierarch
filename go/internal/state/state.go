// Package state is the trierarch's saved state, `~/.aeolus/trierarch/state.json`,
// in the shape today's trierarch saves it: readable by its user only, as it
// holds each crewed ship's crew token (decision 0026), and written whole and
// atomically, so a stop mid-write leaves the last state.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

type File struct {
	Path string
}

// Load reads the state, the empty one when none was saved yet.
func (f File) Load() (reconciler.State, error) {
	text, err := os.ReadFile(f.Path)
	if errors.Is(err, os.ErrNotExist) {
		return reconciler.Empty(), nil
	}
	if err != nil {
		return reconciler.State{}, err
	}
	state := reconciler.Empty()
	if err := json.Unmarshal(text, &state); err != nil {
		return reconciler.State{}, fmt.Errorf("the state at %s is no state: %w", f.Path, err)
	}
	if state.Entries == nil {
		state.Entries = map[string]reconciler.Entry{}
	}
	for shipID, entry := range state.Entries {
		state.Entries[shipID] = fromOldLayout(entry)
	}
	if state.Kept == nil {
		state.Kept = []any{}
	}
	if state.Orphans == nil {
		state.Orphans = []any{}
	}
	if state.Refused == nil {
		state.Refused = map[string]int{}
	}
	return state, nil
}

// fromOldLayout is the entry as this trierarch crews it: one saved before the ship folder layout, its workspace one worktree, names its
// repository as the main of a ship folder, as core rewrote its crew request, and is marked to be crewed again in a fresh one
// (decision 0013: no second layout kept).
func fromOldLayout(entry reconciler.Entry) reconciler.Entry {
	if entry.Workspace.Kind != "worktree" {
		return entry
	}
	entry.Workspace = reconciler.Workspace{Kind: "repositories", Main: reconciler.RepositoryAt{Repository: entry.Workspace.Repository, Ref: entry.Workspace.Ref}}
	entry.IsOldLayout = true
	return entry
}

// Save writes the state whole: to a file beside it, then moved over it.
func (f File) Save(state reconciler.State) error {
	if err := os.MkdirAll(filepath.Dir(f.Path), 0o700); err != nil {
		return err
	}
	text, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	written := f.Path + ".tmp"
	if err := os.WriteFile(written, append(text, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Chmod(written, 0o600); err != nil {
		return err
	}
	return os.Rename(written, f.Path)
}
