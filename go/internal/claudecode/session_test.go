package claudecode

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/commandline"
)

func TestASessionRunsHeadlessWithItsFlagsAndNoQuestionForm(t *testing.T) {
	got := CommandLine([]string{"--model", "opus"}, commandline.Part{}, false, nil)

	want := []string{"claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "opus", "--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode"}
	if !slices.Equal(got, want) {
		t.Fatalf("command %q", got)
	}
}

func TestASessionStartedAgainContinuesItsConversation(t *testing.T) {
	got := CommandLine([]string{}, commandline.Part{}, true, nil)

	if got[len(got)-1] != "--continue" {
		t.Fatalf("command %q", got)
	}
}

func TestAConfiguredPlanModeIsLeftOutInEitherSpelling(t *testing.T) {
	got := CommandLine([]string{"--permission-mode", "plan", "--permission-mode=plan", "--verbose"}, commandline.Part{}, false, nil)

	if slices.Contains(got, "plan") || slices.Contains(got, "--permission-mode=plan") || slices.Contains(got, "--permission-mode") {
		t.Fatalf("command %q", got)
	}
}

func TestAFolderHasAConversationOnceClaudeCodeKeepsOneForIt(t *testing.T) {
	projects := t.TempDir()
	folder := "/home/me/.aeolus/trierarch/worktrees/aeolus-fleet/scout"
	if HasConversation(projects, folder) {
		t.Fatalf("a conversation before any")
	}
	kept := filepath.Join(projects, "-home-me--aeolus-trierarch-worktrees-aeolus-fleet-scout")
	if err := os.MkdirAll(kept, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(kept, "abc.jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if !HasConversation(projects, folder) {
		t.Fatalf("no conversation seen in %s", kept)
	}
}

func TestAPromptIsOneStreamJSONUserMessageWithTheLineThatNoHumanReads(t *testing.T) {
	got := UserLine(WakePrompt())

	want := `{"type":"user","message":{"role":"user","content":"/aeolus-fleet:wake No human reads this terminal. Never ask here; ask over the fleet. A question only a human can answer goes to your ship's owner (argo when argo owns your ship)."}}`
	if got != want {
		t.Fatalf("line %s", got)
	}
}

func TestASessionReadsEachOfItsReadOnlyCheckoutsBesideItsFolderWithoutAsking(t *testing.T) {
	got := CommandLine([]string{"--model", "opus"}, commandline.Part{}, true, []string{"/checkouts/shp_scout/governance", "/checkouts/shp_scout/skills"})

	want := []string{"claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "opus", "--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode", "--continue", "--add-dir", "/checkouts/shp_scout/governance", "--add-dir", "/checkouts/shp_scout/skills"}
	if !slices.Equal(got, want) {
		t.Fatalf("command %q", got)
	}
}
