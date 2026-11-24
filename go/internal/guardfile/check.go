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

// Folder is the ship's guard folder in the state folder's ships directory: its rules, settings and refusals.
func Folder(ships string, shipID string) string {
	return filepath.Join(ships, shipID, "guard")
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
		ShipID string             `json:"shipId"`
		Sets   []guard.AppliedSet `json:"sets"`
	}
	if err := json.Unmarshal(text, &kept); err != nil {
		return guard.Status{}, false, fmt.Errorf("decode guard rules: %w", err)
	}
	if kept.ShipID != shipID {
		return guard.Status{}, false, fmt.Errorf("guard rules do not belong to ship %s", shipID)
	}
	status := guard.Status{Sets: kept.Sets, Recent: []guard.RecentRefusal{}}
	if status.Sets == nil {
		status.Sets = []guard.AppliedSet{}
	}
	lines, err := secrets.ReadPrivate(filepath.Join(Folder(s.Ships, shipID), refusalsFile))
	if errors.Is(err, fs.ErrNotExist) {
		return status, true, nil
	}
	if err != nil {
		return guard.Status{}, false, fmt.Errorf("read refusals: %w", err)
	}
	for _, line := range strings.Split(string(lines), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var refusal guard.Refusal
		if err := json.Unmarshal([]byte(line), &refusal); err != nil {
			return guard.Status{}, false, fmt.Errorf("decode refusal: %w", err)
		}
		status.Refusals++
		status.Recent = append(status.Recent, guard.RecentRefusal{At: refusal.At, Tool: refusal.Tool, Rule: refusal.Rule, Set: refusal.Set, Commit: refusal.Commit})
	}
	if len(status.Recent) > guard.RecentRefusals {
		status.Recent = status.Recent[len(status.Recent)-guard.RecentRefusals:]
	}
	return status, true, nil
}

// Refusals appends each refusal of a ship to refusals.jsonl in its guard folder, one JSON object a line, mode 600.
type Refusals struct {
	Ships  string
	ShipID string
}

// Append keeps the refusal at the end of the file, never through a link.
func (r Refusals) Append(ctx context.Context, refusal guard.Refusal) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !crew.IsShipID(r.ShipID) {
		return errors.New("invalid guard refusals ship id")
	}
	line, err := json.Marshal(refusal)
	if err != nil {
		return fmt.Errorf("encode refusal: %w", err)
	}
	folder := Folder(r.Ships, r.ShipID)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		return fmt.Errorf("make guard folder: %w", err)
	}
	file, err := os.OpenFile(filepath.Join(folder, refusalsFile), os.O_WRONLY|os.O_APPEND|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return fmt.Errorf("open refusals: %w", err)
	}
	if _, err := file.Write(append(line, '\n')); err != nil {
		_ = file.Close()
		return fmt.Errorf("append refusal: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close refusals: %w", err)
	}
	return nil
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
