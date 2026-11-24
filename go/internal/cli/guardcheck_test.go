package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guardfile"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/state"
)

const guardedShip = "shp_01m6jyczpnpp5c0vxh54c966cy"

// noPublishRules are the kept rules of the guarded ship: one set that denies npm publish.
const noPublishRules = `{"fleetId":"flt_01m3tb1zgr5h2ffee12xnch8sv","pluginShipId":"shp_01m6jyczpnpp5c0vxh54c966cz","shipId":"` + guardedShip + `","settingsVersion":3,"sets":[{"name":"no-publish","repository":"fleet/rules","commit":"8d41e07aa1","file":"no-publish.yaml","floor":false,"rules":{"commands":{"deny":[{"command":"npm","args":["publish"]}]}}}]}`

// aGuardedShip is a machine whose state crews the guarded ship in its ship's folder, with the rules given kept for it ("" keeps none).
func aGuardedShip(t *testing.T, rules string) (Machine, paths.Paths, string) {
	t.Helper()
	machine, _, _ := aMain(t)
	// The home as its links resolve, as the guard names the paths it refuses (/tmp is a link on macOS).
	home, err := filepath.EvalSymlinks(machine.HomeDirectory)
	if err != nil {
		t.Fatal(err)
	}
	machine.HomeDirectory, machine.Environ = home, []string{"HOME=" + home}
	at := paths.Of(home, "")
	shipFolder := filepath.Join(at.Ships, guardedShip)
	folder := filepath.Join(shipFolder, "repositories")
	if err := os.MkdirAll(filepath.Join(folder, "main"), 0o700); err != nil {
		t.Fatal(err)
	}
	crewed := reconciler.Empty()
	crewed.Entries[guardedShip] = reconciler.Entry{ShipID: guardedShip, SettingsVersion: 3, Harness: "claude-code", State: "running", Folder: folder, ShipFolder: shipFolder}
	if err := (state.File{Path: at.State}).Save(crewed); err != nil {
		t.Fatal(err)
	}
	if rules != "" {
		if err := (guardfile.Store{Ships: at.Ships}).Write(context.Background(), guardedShip, []byte(rules)); err != nil {
			t.Fatal(err)
		}
	}
	return machine, at, folder
}

// aHookCall is Claude Code's PreToolUse hook input for one tool call in the folder.
func aHookCall(t *testing.T, folder string, tool string, input map[string]any) string {
	t.Helper()
	text, err := json.Marshal(map[string]any{"session_id": "s1", "cwd": filepath.Join(folder, "main"), "hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": input})
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

// guardCheck runs guard check for the ship on the call: what it printed, wrote to stderr and exited with.
func guardCheck(machine Machine, shipID string, call string) (string, string, int) {
	var stderr bytes.Buffer
	machine.Stdin = io.NopCloser(strings.NewReader(call))
	machine.Stderr = &stderr
	output, code := Main([]string{"guard", "check", "--ship", shipID}, machine)
	return output, stderr.String(), code
}

// refusalsOf are the refusals kept for the ship, one JSON object a line.
func refusalsOf(t *testing.T, at paths.Paths, shipID string) []map[string]any {
	t.Helper()
	text, err := os.ReadFile(filepath.Join(at.Ships, shipID, "guard", "refusals.jsonl"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var refusals []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(text)), "\n") {
		var refusal map[string]any
		if err := json.Unmarshal([]byte(line), &refusal); err != nil {
			t.Fatalf("refusal line %q is no JSON: %v", line, err)
		}
		refusals = append(refusals, refusal)
	}
	return refusals
}

func TestGuardCheckRefusesACallTheKeptRulesDenyAndKeepsTheRefusal(t *testing.T) {
	machine, at, folder := aGuardedShip(t, noPublishRules)

	output, stderr, code := guardCheck(machine, guardedShip, aHookCall(t, folder, "Bash", map[string]any{"command": "npm publish"}))

	want := "Refused by the guard: commands.deny npm publish, in no-publish @ 8d41e07."
	if code != 2 || !strings.Contains(output, `"permissionDecision":"deny"`) || strings.TrimSpace(stderr) != want {
		t.Fatalf("guard check = %q, %q, %d, want the deny, %q and exit 2", output, stderr, code, want)
	}
	refusals := refusalsOf(t, at, guardedShip)
	if len(refusals) != 1 || refusals[0]["rule"] != "commands.deny npm publish" || refusals[0]["set"] != "no-publish" ||
		refusals[0]["commit"] != "8d41e07aa1" || refusals[0]["tool"] != "Bash" || refusals[0]["summary"] != "npm publish" || refusals[0]["at"] == nil {
		t.Fatalf("refusals = %v, want the one refusal with its rule, set and commit", refusals)
	}
}

func TestGuardCheckLetsACallTheRulesAllowRunAndKeepsNoRefusal(t *testing.T) {
	machine, at, folder := aGuardedShip(t, noPublishRules)

	output, stderr, code := guardCheck(machine, guardedShip, aHookCall(t, folder, "Bash", map[string]any{"command": "npm test"}))

	if code != 0 || output != "" || stderr != "" {
		t.Fatalf("guard check = %q, %q, %d, want no answer and exit 0", output, stderr, code)
	}
	if refusals := refusalsOf(t, at, guardedShip); refusals != nil {
		t.Fatalf("refusals = %v, want none", refusals)
	}
}

func TestGuardCheckRefusesEveryCallWhileNoRulesAreKept(t *testing.T) {
	machine, _, folder := aGuardedShip(t, "")

	_, stderr, code := guardCheck(machine, guardedShip, aHookCall(t, folder, "Read", map[string]any{"file_path": "README.md"}))

	if want := "Refused by the guard: guard failed: rules unreadable."; code != 2 || strings.TrimSpace(stderr) != want {
		t.Fatalf("guard check = %q, %d, want %q and exit 2", stderr, code, want)
	}
}

func TestGuardCheckRefusesEveryCallOfAShipItDoesNotCrew(t *testing.T) {
	machine, _, folder := aGuardedShip(t, noPublishRules)

	_, stderr, code := guardCheck(machine, "shp_01m6jyczpnpp5c0vxh54c966cx", aHookCall(t, folder, "Read", map[string]any{"file_path": "README.md"}))

	if want := "Refused by the guard: guard failed: ship not crewed here."; code != 2 || strings.TrimSpace(stderr) != want {
		t.Fatalf("guard check = %q, %d, want %q and exit 2", stderr, code, want)
	}
}

func TestGuardCheckRefusesACallWithoutAShip(t *testing.T) {
	machine, _, folder := aGuardedShip(t, noPublishRules)

	_, stderr, code := guardCheck(machine, "", aHookCall(t, folder, "Read", map[string]any{"file_path": "README.md"}))

	if want := "Refused by the guard: guard failed: no ship."; code != 2 || strings.TrimSpace(stderr) != want {
		t.Fatalf("guard check = %q, %d, want %q and exit 2", stderr, code, want)
	}
}

func TestGuardCheckProtectsTheGuardsOwnFilesTheConfigurationAndTheHarnessSettings(t *testing.T) {
	machine, at, folder := aGuardedShip(t, noPublishRules)
	for _, target := range []string{
		filepath.Join(at.Ships, guardedShip, "guard", "refusals.jsonl"),
		filepath.Join(at.Ships, guardedShip, "guard", "settings.json"),
		at.Config,
		filepath.Join(machine.HomeDirectory, ".claude", "settings.json"),
		filepath.Join(folder, "main", ".claude", "settings.local.json"),
	} {
		_, stderr, code := guardCheck(machine, guardedShip, aHookCall(t, folder, "Write", map[string]any{"file_path": target, "content": "{}"}))

		if want := "Refused by the guard: protected: " + target + "."; code != 2 || strings.TrimSpace(stderr) != want {
			t.Errorf("guard check of a write to %s = %q, %d, want %q", target, stderr, code, want)
		}
	}
}

func TestGuardCheckKeepsWritesInsideTheShipsFolder(t *testing.T) {
	machine, _, folder := aGuardedShip(t, noPublishRules)
	outside := filepath.Join(machine.HomeDirectory, "elsewhere.txt")

	_, stderr, code := guardCheck(machine, guardedShip, aHookCall(t, folder, "Write", map[string]any{"file_path": outside, "content": "x"}))

	if want := "Refused by the guard: outside the boundary: " + outside + "."; code != 2 || strings.TrimSpace(stderr) != want {
		t.Fatalf("guard check = %q, %d, want %q", stderr, code, want)
	}
	_, _, code = guardCheck(machine, guardedShip, aHookCall(t, folder, "Write", map[string]any{"file_path": filepath.Join(folder, "main", "notes.md"), "content": "x"}))
	if code != 0 {
		t.Fatalf("a write in the main repository exited %d, want 0", code)
	}
}
