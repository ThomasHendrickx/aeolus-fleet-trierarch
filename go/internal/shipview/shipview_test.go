package shipview

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
)

type filesOnDisk struct{ denied string }

func (f filesOnDisk) Open(path string) (fs.File, error) {
	if path == f.denied {
		return nil, &fs.PathError{Op: "open", Path: path, Err: fs.ErrPermission}
	}
	return os.Open(path)
}

type processFacts struct {
	got     ProcessRequest
	failure error
}

func (p *processFacts) Processes(_ context.Context, request ProcessRequest) ([]Process, error) {
	p.got = request
	return []Process{{PID: 48211, StartedAt: "2026-11-20T13:31:28Z"}}, p.failure
}

func writeFact(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}
func aView(t *testing.T) (paths.Paths, time.Time) {
	t.Helper()
	at := paths.Of(t.TempDir(), "")
	now := time.Date(2026, 11, 20, 14, 2, 31, 0, time.UTC)
	raw := map[string]any{"entries": map[string]any{"shp_one": map[string]any{"shipId": "shp_one", "shipName": "one", "harness": "codex", "state": "running", "since": "2026-11-20T13:30:12Z", "exits": []string{"2026-11-20T13:02:31Z", "2026-11-20T13:02:32Z", "2026-11-20T14:02:30Z"}, "folder": filepath.Join(at.Ships, "shp_one", "repositories"), "shipFolder": filepath.Join(at.Ships, "shp_one"), "workspace": map[string]any{"kind": "repositories"}, "crewToken": "SECRET-CREW-TOKEN"}}}
	data, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	writeFact(t, at.State, string(data))
	return at, now
}

func TestTheReaderShowsRunningSessionsAndTheirProcesses(t *testing.T) {
	at, now := aView(t)
	hold := filepath.Join(at.Sessions, "shp_one")
	process := exec.Command(os.Args[0], "-test.run=TestShipViewHoldProcess", "--", "hold", "shp_one", "--sessions", at.Sessions)
	input, err := process.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = input.Close(); _ = process.Process.Kill(); _ = process.Wait() })
	writeFact(t, filepath.Join(hold, "hold.pid"), strconv.Itoa(process.Process.Pid))
	writeFact(t, filepath.Join(hold, "session-id"), "session-one")
	facts := &processFacts{}
	view, err := (Reader{Files: filesOnDisk{}, Processes: facts}).Ship(context.Background(), at, "one", now)
	if err != nil {
		t.Fatal(err)
	}
	if view.Session.Status != "running" || view.Session.HoldPID != process.Process.Pid || view.Session.SessionID != "session-one" || len(view.Session.Processes) != 1 || view.Session.Processes[0].PID != 48211 || view.Restarts != 2 {
		t.Fatalf("view = %+v", view)
	}
	if facts.got.ShipID != "shp_one" || facts.got.Folder != filepath.Join(at.Ships, "shp_one", "repositories") || facts.got.IsContainer {
		t.Fatalf("process request = %+v", facts.got)
	}
}

func TestShipViewHoldProcess(t *testing.T) {
	for _, arg := range os.Args {
		if arg == "hold" {
			var b [1]byte
			_, _ = os.Stdin.Read(b[:])
			return
		}
	}
}

func TestTheReaderFindsContainerProcessesAndTheirPlaces(t *testing.T) {
	at, now := aView(t)
	writeFact(t, at.Config, `{"runtime":{"kind":"container","binary":"podman"}}`)
	// The test process itself can carry the hold's proof without a socket.
	process := exec.Command(os.Args[0], "-test.run=TestShipViewHoldProcess", "--", "hold", "shp_one", "--sessions", at.Sessions)
	input, err := process.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = input.Close(); _ = process.Process.Kill(); _ = process.Wait() })
	writeFact(t, filepath.Join(at.Sessions, "shp_one", "hold.pid"), strconv.Itoa(process.Process.Pid))
	facts := &processFacts{}
	view, err := (Reader{Files: filesOnDisk{}, Processes: facts}).Ship(context.Background(), at, "shp_one", now)
	if err != nil || !view.IsContainer || !facts.got.IsContainer || facts.got.ContainerBinary != "podman" {
		t.Fatalf("container view = %+v, request %+v, %v", view, facts.got, err)
	}
	if view.Places.Home != filepath.Join(at.Ships, "shp_one", "home") || view.Places.Socket != filepath.Join(at.Ships, "shp_one", "sockets", "fleet.sock") {
		t.Fatalf("places = %+v", view.Places)
	}
}

func TestTheReaderKeepsFactsWhenAFileCannotBeRead(t *testing.T) {
	for _, file := range []string{"hold.pid", "session-id", "exit-reason", "events.jsonl"} {
		t.Run(file, func(t *testing.T) {
			at, now := aView(t)
			path := filepath.Join(at.Sessions, "shp_one", file)
			view, err := (Reader{Files: filesOnDisk{denied: path}}).Ship(context.Background(), at, "one", now)
			if err != nil || view.ShipName != "one" || len(view.Unreadable) != 1 || view.Unreadable[0].Path != path || !strings.Contains(view.Unreadable[0].Error, "permission denied") {
				t.Fatalf("partial view = %+v, %v", view, err)
			}
		})
	}
}

func TestTheReaderDoesNotTurnMissingOrInvalidFactsIntoAReadFailure(t *testing.T) {
	at, now := aView(t)
	writeFact(t, filepath.Join(at.Sessions, "shp_one", "hold.pid"), "SECRET-CREW-TOKEN")
	writeFact(t, filepath.Join(at.Sessions, "shp_one", "events.jsonl"), "not an event\n")
	view, err := Ship(at, "one", now)
	if err != nil || view.Session.Status != "exited" || view.Session.Activity != nil || len(view.Unreadable) != 1 || strings.Contains(view.Unreadable[0].Error, "SECRET") {
		t.Fatalf("view = %+v, %v", view, err)
	}
}

func TestAnExactShipIDWinsOverAnotherShipsName(t *testing.T) {
	at, now := aView(t)
	writeFact(t, at.State, `{"entries":{"shp_one":{"shipId":"shp_one","shipName":"one"},"shp_two":{"shipId":"shp_two","shipName":"shp_one"}}}`)
	view, err := Ship(at, "shp_one", now)
	if err != nil || view.ShipID != "shp_one" {
		t.Fatalf("Ship = %+v, %v", view, err)
	}
}

func TestUnknownShipsAreSortedAndTheErrorCanBeIdentified(t *testing.T) {
	at, now := aView(t)
	writeFact(t, at.State, `{"entries":{"shp_one":{"shipId":"shp_one","shipName":"zebra"},"shp_two":{"shipId":"shp_two","shipName":"alpha"}}}`)
	_, err := Ship(at, "missing", now)
	if !errors.Is(err, ErrShipUnknown) || err.Error() != "No ship missing is crewed here. Crewed here: alpha, zebra." {
		t.Fatalf("Ship = %v", err)
	}
}

func TestTheReaderReportsProcessReadErrorsWithoutLosingTheShip(t *testing.T) {
	at, now := aView(t)
	process := exec.Command(os.Args[0], "-test.run=TestShipViewHoldProcess", "--", "hold", "shp_one", "--sessions", at.Sessions)
	input, err := process.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = input.Close(); _ = process.Process.Kill(); _ = process.Wait() })
	writeFact(t, filepath.Join(at.Sessions, "shp_one", "hold.pid"), strconv.Itoa(process.Process.Pid))
	path := "/proc/123/cwd"
	facts := &processFacts{failure: &fs.PathError{Op: "readlink", Path: path, Err: fs.ErrPermission}}
	view, err := (Reader{Files: filesOnDisk{}, Processes: facts}).Ship(context.Background(), at, "one", now)
	if err != nil || view.ShipName != "one" || !reflect.DeepEqual(view.Unreadable, []Unreadable{{Path: path, Error: "permission denied"}}) {
		t.Fatalf("partial view = %+v, %v", view, err)
	}
}
