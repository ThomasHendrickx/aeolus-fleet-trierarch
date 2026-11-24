// Package guardfile persists the guard's rules outside the ship's worktree.
package guardfile

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/secrets"
)

// Store holds rules in <state>/ships/<shipId>/guard/rules.json. Ships is the
// state folder's ships directory, independent of the workspace location.
type Store struct{ Ships string }

func (s Store) path(shipID string) (string, error) {
	if !crew.IsShipID(shipID) {
		return "", fmt.Errorf("invalid guard rules ship id")
	}
	return filepath.Join(s.Ships, shipID, "guard", "rules.json"), nil
}

// Read reads complete rules, or nil when they have not arrived. Other failures
// stay errors, so unreadable rules are never treated as an empty resolution.
func (s Store) Read(ctx context.Context, shipID string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	path, err := s.path(shipID)
	if err != nil {
		return nil, err
	}
	text, err := secrets.ReadPrivate(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read guard rules: %w", err)
	}
	return text, nil
}

// KeptVersion is the settings version of the rules kept for the ship, false when none are kept.
func (s Store) KeptVersion(ctx context.Context, shipID string) (int, bool, error) {
	text, err := s.Read(ctx, shipID)
	if err != nil || text == nil {
		return 0, false, err
	}
	var kept struct {
		ShipID          string `json:"shipId"`
		SettingsVersion int    `json:"settingsVersion"`
	}
	if err := json.Unmarshal(text, &kept); err != nil {
		return 0, false, fmt.Errorf("decode guard rules: %w", err)
	}
	if kept.ShipID != shipID {
		return 0, false, fmt.Errorf("guard rules do not belong to ship %s", shipID)
	}
	return kept.SettingsVersion, true, nil
}

// Write replaces the file whole through a private, synced temporary file.
// A failed write leaves the old resolution in place for a retry.
func (s Store) Write(ctx context.Context, shipID string, text []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	path, err := s.path(shipID)
	if err != nil {
		return err
	}
	if err := secrets.WritePrivate(path, text); err != nil {
		return fmt.Errorf("write guard rules: %w", err)
	}
	return nil
}
