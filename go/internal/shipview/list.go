package shipview

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/activity"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/claudecode"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/codex"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/copilot"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/eventlog"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mask"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/processproof"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/seen"
)

// Machine holds list facts, with no session content or process commands.
type Machine struct {
	Trierarch  Standing
	Ships      []View
	PassAt     string
	Unreadable []Unreadable
}

// List reads the crewed ships without opening a session's socket or listing its processes.
func List(at paths.Paths, now time.Time) (Machine, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return (Reader{}).List(ctx, at, now)
}

// List reads shared state and observations once, then each ship's latest activity.
// Only the opened ship needs its lines, places, process commands and last end.
func (r Reader) List(ctx context.Context, at paths.Paths, now time.Time) (Machine, error) {
	files := r.Files
	if files == nil {
		files = disk{}
	}
	data, err := readFile(files, at.State)
	if err != nil {
		var source *fs.PathError
		if errors.As(err, &source) {
			err = source.Err
		}
		return Machine{}, fmt.Errorf("cannot read the state at %s: %w", at.State, err)
	}
	var saved struct {
		Entries map[string]entry `json:"entries"`
	}
	if err := json.Unmarshal(data, &saved); err != nil {
		return Machine{}, fmt.Errorf("cannot read the state at %s: %w", at.State, err)
	}
	result := Machine{Ships: []View{}}
	facts := View{}
	var snapshot seen.Snapshot
	path := filepath.Join(at.Home, "seen.json")
	data, err = readFile(files, path)
	if err == nil {
		err = json.Unmarshal(data, &snapshot)
	}
	facts.record("seen", path, err)
	result.PassAt = localTime(snapshot.PassAt, now.Location())
	result.Unreadable = facts.Unreadable
	masker, maskErr := (mask.Loader{Files: files}).Load(ctx, at)
	if maskErr != nil {
		var source *mask.SourceError
		if errors.As(maskErr, &source) {
			facts.Unreadable = append(facts.Unreadable, Unreadable{Fact: "masking", Path: source.Path, Error: source.Err.Error()})
		}
	}
	readers := map[string]func([]string) (activity.Reading, bool){"claude-code": claudecode.ActivityIn, "codex": codex.ActivityIn, "copilot": copilot.ActivityIn}
	for id, one := range saved.Entries {
		if err := ctx.Err(); err != nil {
			return Machine{}, fmt.Errorf("read ship list: %w", err)
		}
		row := View{ShipID: id, ShipName: one.ShipName, Harness: one.Harness, State: one.State, Since: localTime(one.Since, now.Location()), Session: Session{Status: "exited"}, Inbox: &Inbox{IsWatched: false}}
		for _, text := range one.Exits {
			if stamp, err := time.Parse(time.RFC3339, text); err == nil && now.Sub(stamp) >= 0 && now.Sub(stamp) < time.Hour {
				row.Restarts++
			}
		}
		held := hold.FilesOf(at.Sessions, id)
		pidText, err := readFile(files, held.PID)
		row.record("session", held.PID, err)
		pid, _ := strconv.Atoi(strings.TrimSpace(string(pidText)))
		reason, err := readFile(files, held.ExitReason)
		row.record("session", held.ExitReason, err)
		if len(reason) == 0 && pid > 0 && processproof.Runs(pid, "hold", id, "--sessions", at.Sessions) {
			row.Session.Status = "running"
			row.Inbox = nil
			if observation, ok := snapshot.Ships[id]; ok {
				observation.Turn.Since = localTime(observation.Turn.Since, now.Location())
				observation.Turn.SeenAt = localTime(observation.Turn.SeenAt, now.Location())
				row.Session.Turn = &observation.Turn
				row.Inbox = &Inbox{IsWatched: true, Inbox: &observation.Inbox}
			}
		}
		events, err := eventlog.Open(held.Events, files.Open)
		row.record("activity", held.Events, err)
		if err == nil {
			if read := readers[one.Harness]; read != nil {
				var latest activity.Activity
				var ok bool
				tail, err := activityTails(ctx, events)
				if err == nil {
					latest, ok, err = activity.OfFiles(tail, func(line string) (activity.Reading, bool) { return read([]string{line}) })
				}
				row.record("activity", held.Events, err)
				if ok && maskErr == nil {
					row.Session.Activity = &Activity{Kind: latest.Kind, Tool: masker.Line(latest.Tool), At: latest.At.In(now.Location()).Format(time.RFC3339)}
				}
			}
			events.Close()
		}
		row.Unreadable = append(row.Unreadable, facts.Unreadable...)
		result.Ships = append(result.Ships, row)
	}
	slices.SortFunc(result.Ships, func(a, b View) int { return strings.Compare(a.ShipName+"\x00"+a.ShipID, b.ShipName+"\x00"+b.ShipID) })
	return result, nil
}
