package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
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
				if strings.Contains(out, "SECRET-CREW-TOKEN") || strings.Contains(out, "crewToken") || strings.Contains(out, "command") {
					t.Fatalf("status disclosed credentials or commands: %s", out)
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
					want := "Ship: design-tri-271c (shp_one), claude-code, on the host\nState: running since 2026-11-20T13:30:12+01:00, 0 restarts\nSession: exited, hold pid 999999999, session session-one\nActivity: tool Bash, 12s ago\nProcesses: none\nPlaces: ship folder " + filepath.Join(at.Ships, "shp_one", "repositories") + ", hold " + filepath.Join(at.Sessions, "shp_one")
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
