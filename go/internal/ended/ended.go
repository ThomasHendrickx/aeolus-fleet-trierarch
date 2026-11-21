// Package ended keeps the last masked end of each ship's session.
package ended

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
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
		return err
	}
	data, err := json.Marshal(end)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".end-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

// Remove forgets the last end when the ship leaves this machine.
func Remove(home, shipID string) error {
	err := os.Remove(Path(home, shipID))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
