package guardfile

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/secrets"
)

// Folder is the ship's guard folder among the guard folders: its rules, settings and refusals.
func Folder(guards string, shipID string) string {
	return filepath.Join(guards, shipID)
}

// folderMode is a guard folder's mode: only its owner opens it.
const folderMode = 0o700

// MakeFolder makes the ship's guard folder, mode 700, the guard folders made too, and leaves one already there to its owner alone,
// whoever made it: every write to it goes through here first. It answers the folder.
func MakeFolder(guards string, shipID string) (string, error) {
	if !crew.IsShipID(shipID) {
		return "", errors.New("invalid guard folder ship id")
	}
	folder := Folder(guards, shipID)
	if err := os.MkdirAll(folder, folderMode); err != nil {
		return "", fmt.Errorf("make guard folder: %w", err)
	}
	if err := os.Chmod(folder, folderMode); err != nil {
		return "", fmt.Errorf("make guard folder its owner's: %w", err)
	}
	return folder, nil
}

// Sets are the rule sets kept for one ship, as guard check reads them.
type Sets struct {
	Store  Store
	ShipID string
}

// Sets reads the sets of the rules kept for the ship. Rules not kept are an
// error, so guard check fails closed before they arrive.
func (s Sets) Sets(ctx context.Context) ([]json.RawMessage, error) {
	text, err := s.Store.Read(ctx, s.ShipID)
	if err != nil {
		return nil, err
	}
	if text == nil {
		return nil, errors.New("no guard rules kept")
	}
	var kept struct {
		ShipID string            `json:"shipId"`
		Sets   []json.RawMessage `json:"sets"`
	}
	if err := json.Unmarshal(text, &kept); err != nil {
		return nil, fmt.Errorf("decode guard rules: %w", err)
	}
	if kept.ShipID != s.ShipID || kept.Sets == nil {
		return nil, fmt.Errorf("guard rules do not belong to ship %s", s.ShipID)
	}
	return kept.Sets, nil
}

// refusalsFile is where a ship's refusals are kept in its guard folder.
const refusalsFile = "refusals.jsonl"

// GuardStatus is what the guard applies to the ship and what it refused: the sets of the rules kept, and the refusals kept, the last
// twenty of them. False when no rules are kept.
func (s Store) GuardStatus(ctx context.Context, shipID string) (guard.Status, bool, error) {
	text, err := s.Read(ctx, shipID)
	if err != nil || text == nil {
		return guard.Status{}, false, err
	}
	var kept struct {
		ShipID          string             `json:"shipId"`
		SettingsVersion int                `json:"settingsVersion"`
		Sets            []guard.AppliedSet `json:"sets"`
	}
	if err := json.Unmarshal(text, &kept); err != nil {
		return guard.Status{}, false, fmt.Errorf("decode guard rules: %w", err)
	}
	if kept.ShipID != shipID {
		return guard.Status{}, false, fmt.Errorf("guard rules do not belong to ship %s", shipID)
	}
	status := guard.Status{SettingsVersion: kept.SettingsVersion, Sets: kept.Sets, Recent: []guard.RecentRefusal{}}
	if status.Sets == nil {
		status.Sets = []guard.AppliedSet{}
	}
	refusals, err := (Refusals{Guards: s.Guards, ShipID: shipID}).Read(ctx)
	if err != nil {
		return guard.Status{}, false, err
	}
	status.Refusals = len(refusals)
	for _, refusal := range refusals {
		status.Recent = append(status.Recent, guard.RecentRefusal{At: refusal.At, Tool: refusal.Tool, Rule: refusal.Rule, Set: refusal.Set, Commit: refusal.Commit})
	}
	if len(status.Recent) > guard.RecentRefusals {
		status.Recent = status.Recent[len(status.Recent)-guard.RecentRefusals:]
	}
	return status, true, nil
}

// Refusals appends each refusal of a ship to refusals.jsonl in its guard folder, one JSON object a line, mode 600.
type Refusals struct {
	Guards string
	ShipID string
}

// Read reads the ship's refusal records, in order, or none before any are kept.
func (r Refusals) Read(ctx context.Context) ([]guard.Refusal, error) {
	if !crew.IsShipID(r.ShipID) {
		return nil, errors.New("invalid guard refusals ship id")
	}
	lines, err := Within(ctx, func() ([]byte, error) {
		return secrets.ReadPrivate(filepath.Join(Folder(r.Guards, r.ShipID), refusalsFile))
	})
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read refusals: %w", err)
	}
	var refusals []guard.Refusal
	for line := range strings.SplitSeq(string(lines), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var refusal guard.Refusal
		if err := json.Unmarshal([]byte(line), &refusal); err != nil {
			return nil, fmt.Errorf("decode refusal: %w", err)
		}
		refusals = append(refusals, refusal)
	}
	return refusals, nil
}

// Append keeps the refusal at the end of the file, never through a link.
func (r Refusals) Append(ctx context.Context, refusal guard.Refusal) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := appendRecord(r.Guards, r.ShipID, refusalsFile, refusal); err != nil {
		return fmt.Errorf("record refusal: %w", err)
	}
	return nil
}

func appendRecord(guards string, shipID string, name string, record any) error {
	line, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("encode record: %w", err)
	}
	folder, err := MakeFolder(guards, shipID)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(folder, name), os.O_WRONLY|os.O_APPEND|os.O_CREATE|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0o600)
	if err != nil {
		return fmt.Errorf("open log: %w", err)
	}
	_, writeErr := file.Write(append(line, '\n'))
	return errors.Join(writeErr, file.Close())
}

// Links reads the file system's symbolic links.
type Links struct{}

// Readlink is the link's target, or false when path is no link or does not exist.
func (Links) Readlink(ctx context.Context, path string) (string, bool, error) {
	if err := ctx.Err(); err != nil {
		return "", false, err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if info.Mode()&fs.ModeSymlink == 0 {
		return "", false, nil
	}
	target, err := os.Readlink(path)
	if err != nil {
		return "", false, err
	}
	return target, true, nil
}
