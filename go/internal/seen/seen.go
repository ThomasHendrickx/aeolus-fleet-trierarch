// Package seen keeps the inboxes and turns read during the last successful pass.
package seen

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Snapshot is what one successful pass saw, without message content or credentials.
type Snapshot struct {
	PassAt string          `json:"passAt"`
	Ships  map[string]Ship `json:"ships"`
}

// Ship holds only facts actually read while watching a running session.
type Ship struct {
	Inbox Inbox `json:"inbox"`
	Turn  Turn  `json:"turn"`
}

// Inbox is the count read from the fleet and when it was read.
type Inbox struct {
	Waiting int    `json:"waiting"`
	Forced  int    `json:"forced"`
	SeenAt  string `json:"seenAt"`
}

// Turn is the plugin's marker, its original time, and when it was read.
type Turn struct {
	State  string `json:"state"`
	Since  string `json:"since"`
	SeenAt string `json:"seenAt"`
}

// File writes seen.json beside the state, privately and atomically.
type File struct{ Path string }

// Save replaces the whole snapshot; a failed write leaves the last one intact.
func (f File) Save(snapshot Snapshot) error {
	if err := os.MkdirAll(filepath.Dir(f.Path), 0700); err != nil {
		return fmt.Errorf("save seen snapshot: %w", err)
	}
	text, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return fmt.Errorf("save seen snapshot: %w", err)
	}
	temporary := f.Path + ".tmp"
	if err := os.WriteFile(temporary, append(text, '\n'), 0600); err != nil {
		return fmt.Errorf("save seen snapshot: %w", err)
	}
	if err := os.Chmod(temporary, 0600); err != nil {
		return fmt.Errorf("save seen snapshot: %w", err)
	}
	if err := os.Rename(temporary, f.Path); err != nil {
		return fmt.Errorf("save seen snapshot: %w", err)
	}
	return nil
}
