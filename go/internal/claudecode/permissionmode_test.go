package claudecode

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/commandline"
)

func write(t *testing.T, file string, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

const planSettings = `{"permissions":{"defaultMode":"plan"}}`

func TestWithoutAFolderTheLocalSettingsDecidePerFolder(t *testing.T) {
	got := DefaultModeOf(t.TempDir(), filepath.Join(t.TempDir(), "settings.json"), nil, "")

	if !got.IsPerFolder {
		t.Errorf("default mode %v, want per folder", got)
	}
}

func TestOnlyTheUserSettingsAreReadWhenTheFlagsPickThemAndAreDecidedWithoutAFolder(t *testing.T) {
	user := filepath.Join(t.TempDir(), "settings.json")
	write(t, user, planSettings)

	got := DefaultModeOf(t.TempDir(), user, []string{"--setting-sources", "user"}, "")

	if want := (DefaultMode{Mode: "plan"}); got != want {
		t.Errorf("default mode %v, want %v", got, want)
	}
}

func TestNoSettingsSourcesAreReadWithRestricted(t *testing.T) {
	user := filepath.Join(t.TempDir(), "settings.json")
	write(t, user, planSettings)

	if got := DefaultModeOf(t.TempDir(), user, []string{"--restricted"}, ""); got != (DefaultMode{}) {
		t.Errorf("default mode %v, want none", got)
	}
}

func TestTheManagedSettingsWinAndTheLastDropInThatNamesAModelWins(t *testing.T) {
	managed := t.TempDir()
	write(t, filepath.Join(managed, "managed-settings.json"), `{"permissions":{"defaultMode":"acceptEdits"}}`)
	write(t, filepath.Join(managed, "managed-settings.d", "10-a.json"), planSettings)
	write(t, filepath.Join(managed, "managed-settings.d", "20-b.json"), `{}`)
	write(t, filepath.Join(managed, "managed-settings.d", ".hidden.json"), `{"permissions":{"defaultMode":"default"}}`)

	if got := DefaultModeOf(managed, filepath.Join(t.TempDir(), "settings.json"), nil, ""); got != (DefaultMode{Mode: "plan"}) {
		t.Errorf("default mode %v, want plan", got)
	}
}

func TestInlineSettingsOfTheFlagsDecideBeforeTheFilesDo(t *testing.T) {
	got := DefaultModeOf(t.TempDir(), filepath.Join(t.TempDir(), "settings.json"), []string{`--settings={"permissions":{"defaultMode":"plan"}}`}, "")

	if got != (DefaultMode{Mode: "plan"}) {
		t.Errorf("default mode %v, want plan", got)
	}
}

func TestAFoldersOwnSettingsDecideInOrderLocalProjectUser(t *testing.T) {
	folder := t.TempDir()
	write(t, filepath.Join(folder, ".claude", "settings.json"), planSettings)
	write(t, filepath.Join(folder, ".claude", "settings.local.json"), `{"permissions":{"defaultMode":"acceptEdits"}}`)

	if got := DefaultModeOf(t.TempDir(), filepath.Join(t.TempDir(), "settings.json"), nil, folder); got != (DefaultMode{Mode: "acceptEdits"}) {
		t.Errorf("default mode %v, want acceptEdits", got)
	}
}

func TestThePlanOverrideIsManualWhereClaudeCodeListsItAndDefaultBefore(t *testing.T) {
	plan := DefaultMode{Mode: "plan"}

	listed := PlanOverride(nil, plan, []string{"default", "manual", "plan"})
	before := PlanOverride(nil, plan, []string{"default", "plan"})

	if !reflect.DeepEqual(listed, commandline.Part{Words: []string{"--permission-mode", "manual"}, Source: commandline.Adapter}) ||
		!reflect.DeepEqual(before.Words, []string{"--permission-mode", "default"}) {
		t.Errorf("override %v and %v", listed, before)
	}
}

func TestThereIsNoPlanOverrideWhereTheModeIsNotPlanOrTheFlagsNameOne(t *testing.T) {
	for name, override := range map[string]commandline.Part{
		"another mode":         PlanOverride(nil, DefaultMode{Mode: "acceptEdits"}, nil),
		"no mode":              PlanOverride(nil, DefaultMode{}, nil),
		"a mode in the flags":  PlanOverride([]string{"--permission-mode", "acceptEdits"}, DefaultMode{Mode: "plan"}, nil),
		"a mode with an equal": PlanOverride([]string{"--permission-mode=acceptEdits"}, DefaultMode{IsPerFolder: true}, nil),
		"skipped permissions":  PlanOverride([]string{"--dangerously-skip-permissions"}, DefaultMode{Mode: "plan"}, nil),
	} {
		if len(override.Words) != 0 {
			t.Errorf("%s: override %v, want none", name, override)
		}
	}
}

func TestAConfiguredPlanModeDoesNotCountAsTheFlagsNamingAMode(t *testing.T) {
	override := PlanOverride([]string{"--permission-mode", "plan"}, DefaultMode{Mode: "plan"}, nil)

	if len(override.Words) == 0 {
		t.Errorf("override %v, want one: plan mode is left out of the launch", override)
	}
}

func TestPerFolderPlanOverrideSaysWhenItApplies(t *testing.T) {
	override := PlanOverride(nil, DefaultMode{IsPerFolder: true}, nil)

	if override.When != whenPlanPerFolder {
		t.Errorf("override %v", override)
	}
}
