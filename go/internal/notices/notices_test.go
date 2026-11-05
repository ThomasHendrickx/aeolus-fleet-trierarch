package notices

import (
	"strings"
	"testing"
)

var scout = Ship{ID: "shp_1", Name: "scout"}

func TestMessageCutsALongHeadlineToEightyUnitsWithAnEllipsis(t *testing.T) {
	headline := strings.Repeat("a", 100)
	got := Message(headline, "body")
	want := strings.Repeat("a", 79) + "…\n\nbody"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestMessageWritesAHeadlineOnOneLine(t *testing.T) {
	if got := Message("  two\n words  ", "body"); got != "two words\n\nbody" {
		t.Fatalf("got %q", got)
	}
}

func TestCrashSaysArgoCanRestartItToAPersonAndTheConsoleToArgo(t *testing.T) {
	forOwner := Crash(scout, 6, "", false)
	want := "scout crashed 6 times in an hour\n\n- Ship: scout (`shp_1`)\n- Status: crashed, its restart budget spent\n\nargo can restart it in the console."
	if forOwner != want {
		t.Fatalf("got %q", forOwner)
	}
	forArgo := Crash(scout, 6, "claude-code 2.1.306 refused claude-sonnet-5", true)
	want = "scout crashed 6 times in an hour\n\n- Ship: scout (`shp_1`)\n- Status: crashed, its restart budget spent\n- Its last start: claude-code 2.1.306 refused claude-sonnet-5\n\nRestart it in the console to crew it again."
	if forArgo != want {
		t.Fatalf("got %q", forArgo)
	}
}

func TestCrashNamesAShipTheFleetGaveNoNameByItsId(t *testing.T) {
	got := Crash(Ship{ID: "shp_1"}, 6, "", true)
	if !strings.HasPrefix(got, "shp_1 crashed 6 times in an hour\n\n- Ship: `shp_1`\n") {
		t.Fatalf("got %q", got)
	}
}

func TestOwnerUnreachableAddsWhyTheReportCameToArgo(t *testing.T) {
	got := OwnerUnreachable("report", "thomas", "FORBIDDEN", "The network rules do not allow this send")
	want := "report\n\nIts owner thomas could not be reached: FORBIDDEN: The network rules do not allow this send."
	if got != want {
		t.Fatalf("got %q", got)
	}
}

func TestDiscardedCountsEachKindInOrderAndNamesFiveLines(t *testing.T) {
	unsaved := []string{" D gone.txt", " M changed.txt", "R  old -> new", "?? one", "A  two", "commit abc123 a message", "commit def456 another", " M sixth.txt"}
	got := Discarded(scout, "aeolus-fleet", unsaved)
	want := strings.Join([]string{
		"scout released: unpushed work discarded",
		"",
		"- Ship: scout (`shp_1`)",
		"- Worktree: aeolus-fleet",
		"- Discarded: 1 deleted, 2 changed, 1 renamed, 2 new, 2 commits",
		"",
		"- deleted `gone.txt`",
		"- changed `changed.txt`",
		"- renamed `old -> new`",
		"- new `one`",
		"- new `two`",
		"- and 3 more, in this trierarch's log",
	}, "\n")
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

func TestDiscardedCountsOneCommitInTheSingular(t *testing.T) {
	got := Discarded(scout, "aeolus-fleet", []string{"commit abc one"})
	if !strings.Contains(got, "- Discarded: 1 commit\n") || !strings.Contains(got, "- commit `abc one`") {
		t.Fatalf("got %q", got)
	}
}

func TestModelRefusedNamesTheHarnessItsVersionAndTheModel(t *testing.T) {
	got := ModelRefused(scout, "claude-code", "2.1.306", "claude-sonnet-5")
	want := "claude-code refused the model claude-sonnet-5 for scout\n\n- Ship: scout (`shp_1`)\n- Harness: claude-code 2.1.306\n- Model: claude-sonnet-5\n\nThis machine offers the model no more at this version, until `aeolus-trierarch detect` runs by hand."
	if got != want {
		t.Fatalf("got %q", got)
	}
}

func TestSettingsRefusedNamesTheirVersionAndWhy(t *testing.T) {
	got := SettingsRefused(scout, 3, "harness: codex is not offered on this machine")
	want := "Cannot crew scout with its settings\n\n- Ship: scout (`shp_1`)\n- Settings version: 3\n- Why: harness: codex is not offered on this machine"
	if got != want {
		t.Fatalf("got %q", got)
	}
}

func TestIdentityGoneSaysNothingWakesTheShipUntilItIsCrewedAgain(t *testing.T) {
	got := IdentityGone(scout)
	want := "scout is no longer woken: its folder holds no identity\n\n- Ship: scout (`shp_1`)\n\nThe trierarch can no longer report on its behalf, watch its inbox or wake it. Restart it in the console to crew it again."
	if got != want {
		t.Fatalf("got %q", got)
	}
}

func TestKeyNotReadySaysHowEachStateGetsReadyAgain(t *testing.T) {
	ships := []Ship{scout, {ID: "shp_2"}}
	cases := []struct{ state, at, want string }{
		{"refused", "2026-11-04T10:00:00.000Z", "Claude Code's API key was refused\n\n- Harness: claude-code\n- State: refused by its vendor since 2026-11-04T10:00:00.000Z\n- Ships that wait: scout (`shp_1`), `shp_2`\n\nGive it a new key with aeolus-trierarch login claude-code --api-key."},
		{"outOfCredit", "2026-11-04T10:00:00.000Z", "Claude Code's API key is out of credit\n\n- Harness: claude-code\n- State: out of credit since 2026-11-04T10:00:00.000Z\n- Ships that wait: scout (`shp_1`), `shp_2`\n\nIt is checked every 15 minutes; aeolus-trierarch login claude-code --check checks it at once."},
		{"none", "", "Claude Code has no API key\n\n- Harness: claude-code\n- State: no key\n- Ships that wait: scout (`shp_1`), `shp_2`\n\nGive it one with aeolus-trierarch login claude-code --api-key."},
	}
	for _, c := range cases {
		if got := KeyNotReady("claude-code", c.state, c.at, ships); got != c.want {
			t.Errorf("%s: got %q", c.state, got)
		}
	}
}

func TestKeyNotReadyNamesAHarnessItHasNoNameForByItsOwn(t *testing.T) {
	if got := KeyNotReady("copilot", "none", "", []Ship{scout}); !strings.HasPrefix(got, "copilot has no API key\n") {
		t.Fatalf("got %q", got)
	}
}

func TestDetectionProblemSaysTheHarnessItsVersionAndWhatDetectionCouldNotFind(t *testing.T) {
	got := DetectionProblem("claude-code", "2.1.306", "Claude Code 2.1.306's --help names no model alias, so this machine declares no Claude Code model until an update of Claude Code names one")

	want := "claude-code 2.1.306: detection found a problem\n\nClaude Code 2.1.306's --help names no model alias, so this machine declares no Claude Code model until an update of Claude Code names one"
	if got != want {
		t.Errorf("DetectionProblem() = %q, want %q", got, want)
	}
}

func TestDiscardedElsewhereSaysWhyTheWorktreeWentThenTheFacts(t *testing.T) {
	got := DiscardedElsewhere(scout, "aeolus-fleet", []string{" M README.md", "?? draft.md"})
	want := "scout released elsewhere: unpushed work discarded\n\nThe trierarch removed its worktree before crewing it again.\n\n- Ship: scout (`shp_1`)\n- Worktree: aeolus-fleet\n- Discarded: 1 changed, 1 new\n\n- changed `README.md`\n- new `draft.md`"
	if got != want {
		t.Fatalf("got %q", got)
	}
}

func TestStoppedOfferingSaysHowManyShipsFailedTheFirstReasonAndHowTheMachineOffersItselfAgain(t *testing.T) {
	got := StoppedOffering(3, "no activity within a minute of its start")

	want := strings.Join([]string{
		"Session starts fail here: this machine takes no new ships",
		"",
		"- Failed in a row: the starts of 3 ships",
		"- First: no activity within a minute of its start",
		"",
		"It offers itself again for one start 10 minutes after its last failed start, and for good once a start succeeds or the trierarch starts with a changed configuration.",
	}, "\n")
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
