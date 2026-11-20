// Package shipview reads the local facts of a crewed ship without decoding credentials.
package shipview

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/container"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/folderprocess"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/activity"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/claudecode"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/codex"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/copilot"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mask"
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

// Process names a process, when it started and its masked command.
type Process struct {
	PID       int    `json:"pid"`
	StartedAt string `json:"startedAt"`
	Command   string `json:"command"`
}

// Unreadable names a fact's source that could not be read.
type Unreadable struct {
	// Fact identifies the affected fact for a screen; JSON keeps the approved path and error shape.
	Fact  string `json:"-"`
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

// Files opens the local files a view reads. It never opens a socket.
type Files interface {
	Open(path string) (fs.File, error)
}

// ProcessReader reads only process facts from the host or a container.
type ProcessReader interface {
	Processes(context.Context, ProcessRequest) ([]Process, error)
}

// ProcessRequest identifies the running session whose processes are read.
type ProcessRequest struct {
	ShipID          string
	Folder          string
	HoldPID         int
	IsContainer     bool
	ContainerBinary string
	At              time.Time
}

// Reader reads facts from files and the machine's process table.
// Its zero value uses the local machine. Neither port exposes credentials.
type Reader struct {
	Files     Files
	Processes ProcessReader
}

type disk struct{}

func (disk) Open(path string) (fs.File, error) { return os.Open(path) }

// Ship finds an exact id first, then a name, using only this machine.
func Ship(at paths.Paths, ship string, now time.Time) (View, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return (Reader{}).Ship(ctx, at, ship, now)
}

// Ship reads a ship's local facts. A failed fact leaves the other facts available.
func (r Reader) Ship(ctx context.Context, at paths.Paths, ship string, now time.Time) (View, error) {
	files := r.Files
	if files == nil {
		files = disk{}
	}
	data, err := readFile(files, at.State)
	if err != nil {
		var fileError *fs.PathError
		if errors.As(err, &fileError) {
			err = fileError.Err
		}
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
	held := hold.FilesOf(at.Sessions, one.ShipID)
	view := View{
		ShipID: one.ShipID, ShipName: one.ShipName, Harness: one.Harness,
		State: one.State, Since: localTime(one.Since, now.Location()),
		Unreadable: []Unreadable{},
		Session:    Session{Status: "exited", Processes: []Process{}},
		Places: Places{
			ShipFolder: one.Folder, SubRepositories: map[string]string{},
			Home:   paths.ShipHome(at.Homes, one.ShipID, one.ShipFolder),
			Socket: filepath.Join(paths.ShipSockets(at.Sockets, one.ShipID, one.ShipFolder), paths.SocketFile),
			Hold:   held.Folder, Events: held.Events,
		},
	}
	for _, exit := range one.Exits {
		if ended, err := time.Parse(time.RFC3339, exit); err == nil && now.Sub(ended) >= 0 && now.Sub(ended) < time.Hour {
			view.Restarts++
		}
	}
	if one.Workspace.Kind == "repositories" {
		view.Places.Main = filepath.Join(one.Folder, workspace.MainFolder)
		for _, sub := range one.Workspace.SubRepositories {
			view.Places.SubRepositories[sub.Repository] = filepath.Join(one.Folder, workspace.SubRepositoriesFolder, sub.Repository)
		}
	} else {
		view.Places.Main = one.Folder
	}
	read := func(path string) string {
		text, err := readFile(files, path)
		view.record("session", path, err)
		return strings.TrimSpace(string(text))
	}
	var configuration struct {
		Runtime struct {
			Kind   string `json:"kind"`
			Binary string `json:"binary"`
		} `json:"runtime"`
	}
	configurationText, err := readFile(files, at.Config)
	view.record("configuration", at.Config, err)
	if err == nil {
		view.record("configuration", at.Config, json.Unmarshal(configurationText, &configuration))
	}
	view.IsContainer = configuration.Runtime.Kind == "container"
	pidText := read(held.PID)
	if pidText != "" {
		pid, err := strconv.Atoi(pidText)
		if err != nil || pid <= 0 {
			view.Unreadable = append(view.Unreadable, Unreadable{Fact: "session", Path: held.PID, Error: "invalid hold pid"})
		} else {
			view.Session.HoldPID = pid
		}
	}
	view.Session.SessionID = read(held.SessionID)
	reason := read(held.ExitReason)
	if reason == "" && view.Session.HoldPID > 0 && processproof.Runs(view.Session.HoldPID, "hold", one.ShipID, "--sessions", at.Sessions) {
		view.Session.Status = "running"
	}
	readers := map[string]func([]string) (activity.Reading, bool){"claude-code": claudecode.ActivityIn, "codex": codex.ActivityIn, "copilot": copilot.ActivityIn}
	if reader := readers[one.Harness]; reader != nil {
		file, err := files.Open(held.Events)
		view.record("activity", held.Events, err)
		if err == nil {
			latest, ok, err := activity.OfFile(file, func(line string) (activity.Reading, bool) { return reader([]string{line}) })
			_ = file.Close()
			view.record("activity", held.Events, err)
			if ok && err == nil {
				view.Session.Activity = &Activity{latest.Kind, latest.Tool, latest.At.In(now.Location()).Format(time.RFC3339)}
			}
		}
	}
	if view.Session.Status == "running" {
		masker, maskErr := (mask.Loader{Files: files}).Load(at)
		if maskErr != nil {
			view.record("processes", at.State, maskErr)
			return view, nil
		}
		processes := r.Processes
		if processes == nil {
			processes = machineProcesses{}
		}
		found, err := processes.Processes(ctx, ProcessRequest{ShipID: one.ShipID, Folder: one.Folder, HoldPID: view.Session.HoldPID, IsContainer: view.IsContainer, ContainerBinary: configuration.Runtime.Binary, At: now})
		if err != nil {
			view.record("processes", one.Folder, err)
		} else {
			for i := range found {
				found[i].Command = masker.Line(found[i].Command)
			}
			view.Session.Processes = found
		}
	}
	return view, nil
}

func readFile(files Files, path string) ([]byte, error) {
	file, err := files.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(file)
}

func (v *View) record(fact, path string, err error) {
	if err == nil || errors.Is(err, fs.ErrNotExist) {
		return
	}
	var fileError *fs.PathError
	if errors.As(err, &fileError) {
		path = fileError.Path
		err = fileError.Err
	}
	v.Unreadable = append(v.Unreadable, Unreadable{Fact: fact, Path: path, Error: err.Error()})
}

type machineProcesses struct{}

func (machineProcesses) Processes(ctx context.Context, request ProcessRequest) ([]Process, error) {
	var found []folderprocess.Process
	var err error
	if request.IsContainer {
		found, err = (container.Runtime{Binary: request.ContainerBinary}).Processes(ctx, request.ShipID, request.At)
	} else {
		if runtime.GOOS == "linux" {
			path := filepath.Join("/proc", strconv.Itoa(request.HoldPID), "cwd")
			if _, err := os.Readlink(path); err != nil {
				return nil, err
			}
		}
		found, err = folderprocess.In(ctx, request.Folder, request.At)
	}
	if err != nil {
		return nil, err
	}
	processes := make([]Process, 0, len(found))
	for _, each := range found {
		processes = append(processes, Process{PID: each.PID, StartedAt: each.StartedAt.In(request.At.Location()).Format(time.RFC3339), Command: each.Command})
	}
	return processes, nil
}

func localTime(text string, location *time.Location) string {
	if at, err := time.Parse(time.RFC3339, text); err == nil {
		return at.In(location).Format(time.RFC3339)
	}
	return text
}
