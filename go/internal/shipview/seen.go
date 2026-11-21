package shipview

import (
	"encoding/json"
	"path/filepath"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/seen"
)

// Inbox distinguishes a watched count, an unwatched session and a missing observation.
// A nil Inbox in View means no observation was available for a running session.
type Inbox struct {
	IsWatched bool `json:"isWatched"`
	*seen.Inbox
}

func (v *View) readSeen(files Files, at paths.Paths, now time.Time) {
	if v.Session.Status != "running" {
		v.Inbox = &Inbox{IsWatched: false}
		return
	}
	path := filepath.Join(at.Home, "seen.json")
	data, err := readFile(files, path)
	v.record("seen", path, err)
	if err != nil {
		return
	}
	var snapshot seen.Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		v.record("seen", path, err)
		return
	}
	ship, ok := snapshot.Ships[v.ShipID]
	if !ok {
		return
	}
	ship.Inbox.SeenAt = localTime(ship.Inbox.SeenAt, now.Location())
	ship.Turn.Since = localTime(ship.Turn.Since, now.Location())
	ship.Turn.SeenAt = localTime(ship.Turn.SeenAt, now.Location())
	v.Inbox = &Inbox{IsWatched: true, Inbox: &ship.Inbox}
	v.Session.Turn = &ship.Turn
}
