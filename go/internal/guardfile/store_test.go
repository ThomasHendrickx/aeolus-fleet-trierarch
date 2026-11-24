package guardfile

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guard"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/guardrules"
)

const (
	shipID   = "shp_01m6jyczpnpp5c0vxh54c966cy"
	pluginID = "shp_01m6jyczpnpp5c0vxh54c966cz"
	payload  = `{"fleetId":"flt_01m3tb1zgr5h2ffee12xnch8sv","pluginShipId":"shp_01m6jyczpnpp5c0vxh54c966cz","shipId":"shp_01m6jyczpnpp5c0vxh54c966cy","settingsVersion":3,"sets":[{"name":"no-push","repository":"fleet/rules","commit":"8d41e079bd56801e1e2acf18f094c22ade5ec8a9","file":"no-push.yaml","floor":true,"rules":{"git":{"deny":["push"]}}}]}`
)

func aKeeper(root string) *guardrules.Keeper {
	return &guardrules.Keeper{
		Identity: guardrules.Identity{FleetID: "flt_01m3tb1zgr5h2ffee12xnch8sv", PluginShipID: pluginID},
		Store:    Store{Guards: root},
	}
}

func TestRulesAreKeptOutsideTheShipsFolderAndSurviveAProcessRestart(t *testing.T) {
	guards := filepath.Join(t.TempDir(), "guard")
	if outcome, err := aKeeper(guards).Accept(context.Background(), pluginID, payload); err != nil || outcome != guardrules.Applied {
		t.Fatalf("Accept = %v, %v, want applied", outcome, err)
	}

	restarted := aKeeper(guards)
	got, ok, err := restarted.Current(context.Background(), shipID)
	if err != nil || !ok || got.SettingsVersion != 3 || len(got.Sets) != 1 {
		t.Fatalf("Current after restart = %+v, %v, %v, want version 3", got, ok, err)
	}
	if !strings.Contains(string(got.Sets[0]), `"commit":"8d41e079bd56801e1e2acf18f094c22ade5ec8a9"`) || !strings.Contains(string(got.Sets[0]), `"git":{"deny":["push"]}`) {
		t.Fatalf("restarted rules = %s, want the pinned no-push resolution", got.Sets[0])
	}
	path := filepath.Join(guards, shipID, "rules.json")
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("Stat(%s) = %v, %v, want private rules outside repositories", path, info, err)
	}
	if _, err := os.Stat(filepath.Join(guards, shipID, "repositories")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("repositories = %v, want no worktree needed to retain rules", err)
	}
}

func TestMissingRulesAreReportedAsMissing(t *testing.T) {
	text, err := (Store{Guards: t.TempDir()}).Read(context.Background(), shipID)
	if err != nil || text != nil {
		t.Fatalf("Read(missing) = %q, %v, want nil", text, err)
	}
}

func TestRulesCannotUseAShipPathToEscapeStorage(t *testing.T) {
	store := Store{Guards: t.TempDir()}
	for _, ship := range []string{"../elsewhere", "/absolute", "", "shp_invalid"} {
		t.Run(ship, func(t *testing.T) {
			if _, err := store.Read(context.Background(), ship); err == nil {
				t.Fatal("Read accepted a ship path")
			}
			if err := store.Write(context.Background(), ship, []byte(payload)); err == nil {
				t.Fatal("Write accepted a ship path")
			}
		})
	}
}

func TestRulesNeitherReadNorWriteThroughALink(t *testing.T) {
	guards := t.TempDir()
	target := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(target, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(guards, shipID)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(folder, "rules.json")); err != nil {
		t.Fatal(err)
	}
	store := Store{Guards: guards}
	if _, err := store.Read(context.Background(), shipID); err == nil {
		t.Fatal("Read followed a link")
	}
	if err := store.Write(context.Background(), shipID, []byte(payload)); err == nil {
		t.Fatal("Write followed a link")
	}
	text, err := os.ReadFile(target)
	if err != nil || string(text) != "keep" {
		t.Fatalf("target = %q, %v, want unchanged", text, err)
	}
}

func TestStorageFailuresAreReturnedRatherThanReportedAsMissingRules(t *testing.T) {
	root := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(root, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	store := Store{Guards: root}
	if _, err := store.Read(context.Background(), shipID); err == nil {
		t.Fatal("Read hid a storage failure")
	}
	if err := store.Write(context.Background(), shipID, []byte(payload)); err == nil {
		t.Fatal("Write hid a storage failure")
	}
}

func TestCancelledStorageDoesNotPersistRules(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	store := Store{Guards: t.TempDir()}
	if err := store.Write(ctx, shipID, []byte(payload)); !errors.Is(err, context.Canceled) {
		t.Fatalf("Write(cancelled) = %v", err)
	}
	if _, err := store.Read(ctx, shipID); !errors.Is(err, context.Canceled) {
		t.Fatalf("Read(cancelled) = %v", err)
	}
	if text, err := store.Read(context.Background(), shipID); err != nil || text != nil {
		t.Fatalf("Read = %q, %v, want nothing persisted", text, err)
	}
}

func TestTheKeptVersionIsTheSettingsVersionOfTheRulesKeptForTheShip(t *testing.T) {
	store := Store{Guards: filepath.Join(t.TempDir(), "guard")}
	if _, ok, err := store.KeptVersion(context.Background(), shipID); ok || err != nil {
		t.Fatalf("KeptVersion before any rules = %v, %v, want none", ok, err)
	}
	if err := store.Write(context.Background(), shipID, []byte(payload)); err != nil {
		t.Fatal(err)
	}

	version, ok, err := store.KeptVersion(context.Background(), shipID)

	if version != 3 || !ok || err != nil {
		t.Fatalf("KeptVersion = %d, %v, %v, want 3", version, ok, err)
	}
}

func TestTheGuardStatusIsTheKeptSetsAndTheLastTwentyRefusals(t *testing.T) {
	guards := filepath.Join(t.TempDir(), "guard")
	store := Store{Guards: guards}
	if err := store.Write(context.Background(), shipID, []byte(payload)); err != nil {
		t.Fatal(err)
	}
	refusals := Refusals{Guards: guards, ShipID: shipID}
	set, commit := "no-push", "8d41e079bd56801e1e2acf18f094c22ade5ec8a9"
	for second := range 21 {
		refusal := guard.Refusal{At: time.Date(2026, 11, 24, 21, 0, second, 0, time.UTC), Tool: "Bash", Rule: "git.deny push", Set: &set, Commit: &commit, Summary: "git push"}
		if second == 20 {
			refusal = guard.Refusal{At: time.Date(2026, 11, 24, 21, 0, second, 0, time.UTC), Tool: "Write", Rule: "protected: /home/crew/.claude/settings.json", Summary: "{}"}
		}
		if err := refusals.Append(context.Background(), refusal); err != nil {
			t.Fatal(err)
		}
	}

	status, ok, err := store.GuardStatus(context.Background(), shipID)

	if err != nil || !ok {
		t.Fatalf("GuardStatus = %v, %v, want a status", ok, err)
	}
	if len(status.Sets) != 1 || status.Sets[0] != (guard.AppliedSet{Name: "no-push", Repository: "fleet/rules", Commit: commit, Floor: true}) {
		t.Fatalf("sets = %+v, want the kept no-push set", status.Sets)
	}
	last := status.Recent[len(status.Recent)-1]
	if status.Refusals != 21 || len(status.Recent) != 20 || status.Recent[0].At.Second() != 1 || last.Tool != "Write" || last.Set != nil || last.Commit != nil {
		t.Fatalf("status = %d refusals, %+v, want 21 and the last twenty, the mechanism's with no set", status.Refusals, status.Recent)
	}
}

func TestTheGuardStatusNamesTheSettingsVersionItsRulesWereKeptFor(t *testing.T) {
	store := Store{Guards: filepath.Join(t.TempDir(), "guard")}
	if err := store.Write(context.Background(), shipID, []byte(payload)); err != nil {
		t.Fatal(err)
	}

	status, _, err := store.GuardStatus(context.Background(), shipID)

	if err != nil || status.SettingsVersion != 3 {
		t.Fatalf("GuardStatus = %d, %v, want settings version 3", status.SettingsVersion, err)
	}
}

func TestAStalledRulesReadEndsWithItsContext(t *testing.T) {
	guards := filepath.Join(t.TempDir(), "guard")
	if err := os.MkdirAll(filepath.Join(guards, shipID), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(guards, shipID, "rules.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	read := make(chan error, 1)

	go func() { _, err := (Store{Guards: guards}).Read(ctx, shipID); read <- err }()

	select {
	case err := <-read:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Read = %v, want its context's end", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the read still ran 3 seconds after its context ended")
	}
}

func TestForgettingAShipRemovesItsWholeGuardFolder(t *testing.T) {
	guards := filepath.Join(t.TempDir(), "guard")
	store := Store{Guards: guards}
	if err := store.Write(context.Background(), shipID, []byte(payload)); err != nil {
		t.Fatal(err)
	}
	if err := (Refusals{Guards: guards, ShipID: shipID}).Append(context.Background(), guard.Refusal{Tool: "Bash", Rule: "git.deny push"}); err != nil {
		t.Fatal(err)
	}

	if err := store.Forget(context.Background(), shipID); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(Folder(guards, shipID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("guard folder = %v, want it removed", err)
	}
	if err := store.Forget(context.Background(), shipID); err != nil {
		t.Fatalf("Forget again = %v, want nothing to do", err)
	}
	if err := store.Forget(context.Background(), "../elsewhere"); err == nil {
		t.Fatal("Forget accepted a ship path")
	}
}
