package cli

import (
	"encoding/json"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/shipview"
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

func aShipStatus(t *testing.T) (Machine, paths.Paths) {
	t.Helper()
	home := t.TempDir()
	at := paths.Of(home, "")
	folder := filepath.Join(at.Ships, "shp_one")
	workspace := filepath.Join(folder, "repositories")
	state := `{"entries":{"shp_one":{"shipId":"shp_one","shipName":"design-tri-271c","harness":"claude-code","state":"running","since":"2026-11-20T13:30:12+01:00","exits":[],"shipFolder":` + quoted(folder) + `,"folder":` + quoted(workspace) + `,"workspace":{"kind":"repositories","subRepositories":[{"repository":"tools"}]},"crewToken":"SECRET-CREW-TOKEN"}}}`
	writeStatusFile(t, at.State, state)
	writeStatusFile(t, filepath.Join(at.Sessions, "shp_one", "hold.pid"), "999999999\n")
	writeStatusFile(t, filepath.Join(at.Sessions, "shp_one", "session-id"), "session-one\n")
	writeStatusFile(t, filepath.Join(at.Sessions, "shp_one", "exit-reason"), "exit status 1")
	events := filepath.Join(at.Sessions, "shp_one", "events.jsonl")
	writeStatusFile(t, events, `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"SECRET-CREW-TOKEN"}}]}}`+"\n")
	now, _ := time.Parse(time.RFC3339, "2026-11-20T14:02:31+01:00")
	if err := os.Chtimes(events, now.Add(-12*time.Second), now.Add(-12*time.Second)); err != nil {
		t.Fatal(err)
	}
	return Machine{HomeDirectory: home, Now: func() time.Time { return now }}, at
}

func quoted(s string) string { b, _ := json.Marshal(s); return string(b) }
func writeStatusFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestShipStatusShowsLocalFactsByNameOrIDWithoutCredentials(t *testing.T) {
	for _, name := range []string{"design-tri-271c", "shp_one"} {
		t.Run(name, func(t *testing.T) {
			machine, at := aShipStatus(t)
			for _, isJSON := range []bool{false, true} {
				args := []string{"status", name}
				if isJSON {
					args = append(args, "--json")
				}
				out, code := Main(args, machine)
				if code != 0 {
					t.Fatalf("status = %d, %s", code, out)
				}
				if strings.Contains(out, "SECRET-CREW-TOKEN") || strings.Contains(out, "crewToken") {
					t.Fatalf("status disclosed credentials: %s", out)
				}
				if isJSON {
					var got struct {
						ShipID   string
						ShipName string
						Harness  string
						Since    string
						Restarts int
						Places   map[string]any
						Session  struct {
							Status    string
							HoldPid   int
							SessionID string
							Activity  struct {
								Kind string
								Tool string
								At   string
							}
							Processes []any
						}
						Unreadable []any
					}
					if err := json.Unmarshal([]byte(out), &got); err != nil {
						t.Fatal(err)
					}
					if got.ShipID != "shp_one" || got.ShipName != "design-tri-271c" || got.Session.Status != "exited" || got.Session.HoldPid != 999999999 || got.Session.SessionID != "session-one" || got.Session.Activity.Kind != "tool" || got.Session.Activity.Tool != "Bash" || len(got.Session.Processes) != 0 || len(got.Unreadable) != 0 {
						t.Fatalf("facts = %+v", got)
					}
					if got.Places["main"] != filepath.Join(at.Ships, "shp_one", "repositories", "main") {
						t.Fatalf("places = %v", got.Places)
					}
				} else {
					want := "Ship: design-tri-271c (shp_one), claude-code, on the host\nState: running since 2026-11-20T13:30:12+01:00, 0 restarts\nTurn: -\nActivity: tool Bash, 12s ago\nInbox: not watched while no session runs\nProcesses: none\nLast end: none kept: no session of this ship ended since it was crewed here\nPlaces: ship folder " + filepath.Join(at.Ships, "shp_one", "repositories") + ", hold " + filepath.Join(at.Sessions, "shp_one")
					want += "\nLast lines:\n  --:--:-- tool Bash {\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Bash\",\"input\":{\"command\":\"[masked: crew token]\"}}]}}"
					if out != want {
						t.Fatalf("status = %s\nwant %s", out, want)
					}
				}
			}
		})
	}
}

func TestUnknownShipStatusNamesTheShipsCrewedHere(t *testing.T) {
	machine, _ := aShipStatus(t)
	out, code := Main([]string{"status", "missing"}, machine)
	if code != 1 || out != "No ship missing is crewed here. Crewed here: design-tri-271c." {
		t.Fatalf("status = %d, %s", code, out)
	}
}

func TestShipStatusKeepsOtherFactsWhenASessionFileIsUnreadable(t *testing.T) {
	machine, at := aShipStatus(t)
	path := filepath.Join(at.Sessions, "shp_one", "session-id")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	for _, flag := range [][]string{{}, {"--json"}} {
		out, code := Main(append([]string{"status", "shp_one"}, flag...), machine)
		if code != 0 || !strings.Contains(out, path) || !strings.Contains(out, "is a directory") || !strings.Contains(out, "Bash") {
			t.Fatalf("partial status = %d, %s", code, out)
		}
	}
}

func TestShipStatusCannotReadAnInvalidState(t *testing.T) {
	machine, at := aShipStatus(t)
	writeStatusFile(t, at.State, `{"crewToken":"SECRET-CREW-TOKEN",`)
	out, code := Main([]string{"status", "shp_one"}, machine)
	if code != 1 || !strings.Contains(out, "cannot read the state at "+at.State) || strings.Contains(out, "SECRET-CREW-TOKEN") {
		t.Fatalf("invalid state = %d, %s", code, out)
	}
}

func TestShipStatusJSONMatchesTheApprovedFactsShape(t *testing.T) {
	machine, at := aShipStatus(t)
	out, code := Main([]string{"status", "shp_one", "--json"}, machine)
	want := strings.ReplaceAll(`{
 "shipId":"shp_one","shipName":"design-tri-271c","harness":"claude-code","isContainer":false,
 "state":"running","since":"2026-11-20T13:30:12+01:00","restarts":0,
 "places":{
 "shipFolder":"@ROOT@/ships/shp_one/repositories","main":"@ROOT@/ships/shp_one/repositories/main",
 "subRepositories":{"tools":"@ROOT@/ships/shp_one/repositories/sub-repos/tools"},
 "home":"@ROOT@/ships/shp_one/home","socket":"@ROOT@/ships/shp_one/sockets/fleet.sock",
 "hold":"@ROOT@/sessions/shp_one","events":"@ROOT@/sessions/shp_one/events.jsonl"
 },
 "session":{"status":"exited","holdPid":999999999,"sessionId":"session-one","turn":null,
 "activity":{"kind":"tool","tool":"Bash","at":"2026-11-20T14:02:19+01:00"},"processes":[]},
 "lastEnd":null,
 "inbox":{"isWatched":false},
 "lines":[{"at":"","kind":"tool","tool":"Bash","line":"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Bash\",\"input\":{\"command\":\"[masked: crew token]\"}}]}}"}],"unreadable":[]
}`, "@ROOT@", at.Home)
	var gotJSON, wantJSON any
	if err := json.Unmarshal([]byte(out), &gotJSON); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &wantJSON); err != nil {
		t.Fatal(err)
	}
	if code != 0 || !reflect.DeepEqual(gotJSON, wantJSON) {
		t.Fatalf("JSON = %d, %s; want %s", code, out, want)
	}
}

func aRunningShipStatus(t *testing.T) (Machine, paths.Paths, int) {
	t.Helper()
	machine, at := aShipStatus(t)
	folder := filepath.Join(at.Ships, "shp_one", "repositories")
	if err := os.MkdirAll(folder, 0700); err != nil {
		t.Fatal(err)
	}
	start := func(dir string, args ...string) *exec.Cmd {
		t.Helper()
		process := exec.Command(os.Args[0], append([]string{"-test.run=TestShipStatusProcess", "--"}, args...)...)
		process.Dir = dir
		input, err := process.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		if err := process.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = input.Close(); _ = process.Process.Kill(); _ = process.Wait() })
		return process
	}
	held := start(at.Home, "hold", "shp_one", "--sessions", at.Sessions)
	child := start(folder, "SECRET-CREW-TOKEN")
	writeStatusFile(t, filepath.Join(at.Sessions, "shp_one", "hold.pid"), strconv.Itoa(held.Process.Pid))
	if err := os.Remove(filepath.Join(at.Sessions, "shp_one", "exit-reason")); err != nil {
		t.Fatal(err)
	}
	return machine, at, child.Process.Pid
}

func TestShipStatusShowsRunningProcessesWithMaskedCommands(t *testing.T) {
	machine, _, childPID := aRunningShipStatus(t)
	for _, flags := range [][]string{{}, {"--json"}} {
		out, code := Main(append([]string{"status", "shp_one"}, flags...), machine)
		if code != 0 || !strings.Contains(out, strconv.Itoa(childPID)) || strings.Contains(out, "SECRET-CREW-TOKEN") || !strings.Contains(out, "[masked: crew token]") {
			t.Fatalf("process facts = %d, %s", code, out)
		}
		if len(flags) > 0 {
			var view struct {
				Session struct {
					Status    string
					Processes []struct {
						PID       int
						StartedAt string
						Command   string
					}
				}
			}
			if err := json.Unmarshal([]byte(out), &view); err != nil {
				t.Fatal(err)
			}
			if view.Session.Status != "running" || len(view.Session.Processes) != 1 || view.Session.Processes[0].PID != childPID || view.Session.Processes[0].StartedAt == "" || !strings.Contains(view.Session.Processes[0].Command, "[masked: crew token]") {
				t.Fatalf("process facts = %+v", view)
			}
		} else if !strings.Contains(out, "Processes: "+strconv.Itoa(childPID)+" for ") {
			t.Fatalf("process text = %s", out)
		}
	}
}

func TestShipStatusHidesCommandsWhenCredentialsAreUnreadable(t *testing.T) {
	machine, at, _ := aRunningShipStatus(t)
	if err := os.Mkdir(at.ModelToken, 0700); err != nil {
		t.Fatal(err)
	}
	for _, flags := range [][]string{{}, {"--json"}} {
		out, code := Main(append([]string{"status", "shp_one"}, flags...), machine)
		if code != 0 || strings.Contains(out, "SECRET-CREW-TOKEN") || strings.Contains(out, "TestShipStatusProcess") || !strings.Contains(out, at.ModelToken) {
			t.Fatalf("unmaskable commands = %d, %s", code, out)
		}
	}
}

func TestShipStatusShowsWholeMaskedLinesAfterTheirTimeKindAndTool(t *testing.T) {
	machine, at := aShipStatus(t)
	event := `{"timestamp":"2026-11-20T13:31:27+01:00","type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"SECRET-CREW-TOKEN ` + strings.Repeat("whole ", 200) + `"}}]}}`
	writeStatusFile(t, filepath.Join(at.Sessions, "shp_one", "events.jsonl"), event+"\n")
	out, code := Main([]string{"status", "shp_one"}, machine)
	want := "Last lines:\n  13:31:27 tool Bash " + strings.ReplaceAll(event, "SECRET-CREW-TOKEN", "[masked: crew token]")
	if code != 0 || !strings.HasSuffix(out, want) {
		t.Fatalf("whole lines = %d, %s", code, out)
	}
}

func TestShipStatusHidesLinesWhenCredentialsAreUnreadable(t *testing.T) {
	machine, at := aShipStatus(t)
	writeStatusFile(t, filepath.Join(at.Sessions, "shp_one", "events.jsonl"), "whole fake-event\n")
	if err := os.Mkdir(at.ModelToken, 0700); err != nil {
		t.Fatal(err)
	}
	out, code := Main([]string{"status", "shp_one"}, machine)
	if code != 0 || !strings.Contains(out, "Last lines: not shown: cannot read "+at.ModelToken+" to mask it (is a directory)") || strings.Contains(out, "whole ") {
		t.Fatalf("unmaskable lines = %d, %s", code, out)
	}
}

func TestShipStatusProcess(t *testing.T) {
	for _, arg := range os.Args {
		if arg == "--" {
			var b [1]byte
			_, _ = os.Stdin.Read(b[:])
			return
		}
	}
}

func TestShipStatusNamesTheUnreadableFactAsTheScreenDoes(t *testing.T) {
	view := shipview.View{ShipID: "shp_one", ShipName: "one", Harness: "codex", State: "running", Since: "2026-11-20T13:30:12Z", Unreadable: []shipview.Unreadable{{Path: "/proc/48102/cwd", Error: "permission denied", Fact: "processes"}}}
	out := describeShip(view, time.Date(2026, 11, 20, 14, 2, 31, 0, time.UTC))
	if !strings.Contains(out, "Processes: unreadable: /proc/48102/cwd: permission denied") || strings.Contains(out, "Processes: none") || strings.Contains(out, "Unreadable:") {
		t.Fatalf("partial text = %s", out)
	}
}
