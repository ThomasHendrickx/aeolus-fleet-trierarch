// Package shipview reads the local facts of a crewed ship without decoding credentials.
package shipview

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/activity"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/claudecode"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/codex"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/copilot"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/processproof"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/workspace"
)

// ErrShipUnknown means the state names no such ship.
var ErrShipUnknown = errors.New("ship is not crewed here")

type unknownShip struct {
	name   string
	crewed []string
}

func (e unknownShip) Error() string {
	return fmt.Sprintf("No ship %s is crewed here. Crewed here: %s.", e.name, strings.Join(e.crewed, ", "))
}
func (e unknownShip) Unwrap() error { return ErrShipUnknown }

// View contains facts only. Session content and credentials have no fields here.
type View struct {
	ShipID      string       `json:"shipId"`
	ShipName    string       `json:"shipName"`
	Harness     string       `json:"harness"`
	IsContainer bool         `json:"isContainer"`
	State       string       `json:"state"`
	Since       string       `json:"since"`
	Restarts    int          `json:"restarts"`
	Places      Places       `json:"places"`
	Session     Session      `json:"session"`
	Unreadable  []Unreadable `json:"unreadable"`
}

// Places names the files and folders belonging to a ship.
type Places struct {
	ShipFolder      string            `json:"shipFolder"`
	Main            string            `json:"main"`
	SubRepositories map[string]string `json:"subRepositories"`
	Home            string            `json:"home"`
	Socket          string            `json:"socket"`
	Hold            string            `json:"hold"`
	Events          string            `json:"events"`
}

// Session is what the hold's files say about its session.
type Session struct {
	Status    string    `json:"status"`
	HoldPID   int       `json:"holdPid"`
	SessionID string    `json:"sessionId"`
	Activity  *Activity `json:"activity"`
	Processes []Process `json:"processes"`
}

// Activity is the latest event's kind and tool, never its content.
type Activity struct {
	Kind string `json:"kind"`
	Tool string `json:"tool,omitempty"`
	At   string `json:"at"`
}

// Process names a process and when it started, without its command line.
type Process struct {
	PID       int    `json:"pid"`
	StartedAt string `json:"startedAt"`
}

// Unreadable names a fact's source that could not be read.
type Unreadable struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// entry is intentionally independent of state.Entry: no secret can be decoded.
type entry struct {
	ShipID     string   `json:"shipId"`
	ShipName   string   `json:"shipName"`
	Harness    string   `json:"harness"`
	State      string   `json:"state"`
	Since      string   `json:"since"`
	Exits      []string `json:"exits"`
	Folder     string   `json:"folder"`
	ShipFolder string   `json:"shipFolder"`
	Workspace  struct {
		Kind            string `json:"kind"`
		SubRepositories []struct {
			Repository string `json:"repository"`
		} `json:"subRepositories"`
	} `json:"workspace"`
}

// Ship finds an exact id first, then a name, using only files on this machine.
func Ship(at paths.Paths, ship string, now time.Time) (View, error) {
	data, err := os.ReadFile(at.State)
	if err != nil {
		return View{}, fmt.Errorf("cannot read the state at %s: %w", at.State, err)
	}
	var saved struct {
		Entries map[string]entry `json:"entries"`
	}
	if err := json.Unmarshal(data, &saved); err != nil {
		return View{}, fmt.Errorf("cannot read the state at %s: %w", at.State, err)
	}
	one, found := saved.Entries[ship]
	if !found {
		for _, candidate := range saved.Entries {
			if candidate.ShipName == ship {
				one, found = candidate, true
				break
			}
		}
	}
	if !found {
		names := []string{}
		for id, each := range saved.Entries {
			name := each.ShipName
			if name == "" {
				name = id
			}
			names = append(names, name)
		}
		slices.Sort(names)
		return View{}, unknownShip{ship, names}
	}
	files := hold.FilesOf(at.Sessions, one.ShipID)
	view := View{ShipID: one.ShipID, ShipName: one.ShipName, Harness: one.Harness, State: one.State, Since: localTime(one.Since), Restarts: len(one.Exits), Unreadable: []Unreadable{}, Session: Session{Status: "exited", Processes: []Process{}}, Places: Places{ShipFolder: one.Folder, SubRepositories: map[string]string{}, Home: paths.ShipHome(at.Homes, one.ShipID, one.ShipFolder), Socket: filepath.Join(paths.ShipSockets(at.Sockets, one.ShipID, one.ShipFolder), paths.SocketFile), Hold: files.Folder, Events: files.Events}}
	if one.Workspace.Kind == "repositories" {
		view.Places.Main = filepath.Join(one.Folder, workspace.MainFolder)
		for _, sub := range one.Workspace.SubRepositories {
			view.Places.SubRepositories[sub.Repository] = filepath.Join(one.Folder, workspace.SubRepositoriesFolder, sub.Repository)
		}
	} else {
		view.Places.Main = one.Folder
	}
	read := func(path string) string {
		text, err := os.ReadFile(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			view.Unreadable = append(view.Unreadable, Unreadable{path, err.Error()})
		}
		return strings.TrimSpace(string(text))
	}
	pidText := read(files.PID)
	if pidText != "" {
		pid, err := strconv.Atoi(pidText)
		if err != nil || pid <= 0 {
			view.Unreadable = append(view.Unreadable, Unreadable{files.PID, "invalid hold pid"})
		} else {
			view.Session.HoldPID = pid
		}
	}
	view.Session.SessionID = read(files.SessionID)
	reason := read(files.ExitReason)
	if reason == "" && view.Session.HoldPID > 0 && processproof.Runs(view.Session.HoldPID, "hold", one.ShipID, "--sessions", at.Sessions) {
		view.Session.Status = "running"
	}
	readers := map[string]func([]string) (activity.Reading, bool){"claude-code": claudecode.ActivityIn, "codex": codex.ActivityIn, "copilot": copilot.ActivityIn}
	if reader := readers[one.Harness]; reader != nil {
		if _, err := os.Stat(files.Events); err != nil && !errors.Is(err, os.ErrNotExist) {
			view.Unreadable = append(view.Unreadable, Unreadable{files.Events, err.Error()})
		} else if latest, ok := activity.Of(files.Events, func(line string) (activity.Reading, bool) { return reader([]string{line}) }); ok {
			view.Session.Activity = &Activity{latest.Kind, latest.Tool, latest.At.Local().Format(time.RFC3339)}
		}
	}
	_ = now
	return view, nil
}

func localTime(text string) string {
	if at, err := time.Parse(time.RFC3339, text); err == nil {
		return at.Local().Format(time.RFC3339)
	}
	return text
}
