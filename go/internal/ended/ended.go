// Package ended keeps the last masked end of each ship's session.
package ended

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/secrets"
)

// Line is a whole masked event with its harness reading and own timestamp.
type Line struct {
	At   string `json:"at"`
	Kind string `json:"kind"`
	Tool string `json:"tool,omitempty"`
	Line string `json:"line"`
}

// Activity is the last event's kind, tool and time.
type Activity struct {
	Kind string `json:"kind"`
	Tool string `json:"tool,omitempty"`
	At   string `json:"at"`
}

// End is the evidence kept before a session's hold files go.
type End struct {
	EndedAt    string    `json:"endedAt"`
	StartedAt  string    `json:"startedAt"`
	ExitReason string    `json:"exitReason"`
	Harness    string    `json:"harness"`
	SessionID  string    `json:"sessionId"`
	Activity   *Activity `json:"activity"`
	Lines      []Line    `json:"lines"`
	// LinesError explains why lines could not safely be kept.
	LinesError string `json:"linesError,omitempty"`
}

// Path is where a ship's last end lives, beside ships/.
func Path(home, shipID string) string { return filepath.Join(home, "ended", shipID+".json") }

// Write atomically replaces the last end, readable by its user alone.
func Write(home, shipID string, end End) error {
	path := Path(home, shipID)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("create ended directory: %w", err)
	}
	data, err := json.Marshal(end)
	if err != nil {
		return fmt.Errorf("marshal last end: %w", err)
	}
	if err := secrets.WritePrivate(path, data); err != nil {
		return fmt.Errorf("write last end: %w", err)
	}
	return nil
}

// Remove forgets the last end when the ship leaves this machine.
func Remove(home, shipID string) error {
	err := os.Remove(Path(home, shipID))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
