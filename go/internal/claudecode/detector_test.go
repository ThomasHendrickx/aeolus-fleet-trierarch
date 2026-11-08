package claudecode

import (
	"context"
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
)

var (
	detectedBefore = time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	detectedNow    = time.Date(2026, 10, 8, 15, 0, 0, 0, time.UTC)
)

const neutralFolder = "/tmp/trierarch-probe-x1"

var help = strings.Join([]string{
	"Usage: claude [options] [command] [prompt]",
	"  --model <model>                   Model for the current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name.",
	"  --effort <level>                  Effort level for the current session (low, medium, high, xhigh, max)",
}, "\n")

// wrappedHelp is `claude --help` of Claude Code 2.1.295 as the mac mini prints it, cut to its two options: each description wraps over several lines (#383).
var wrappedHelp = strings.Join([]string{
	"Usage: claude [options] [command] [prompt]",
	"  --effort <level>                      Effort level for the current session",
	"                                        (low, medium, high, xhigh, max)",
	"  --environment <environment_id>        Create a new cloud session that runs on",
	"                                        the given self-hosted environment",
	"                                        (ccpool_...).",
	"  --model <model>                       Model for the current session. Provide",
	"                                        an alias for the latest model (e.g.",
	"                                        'fable', 'opus', or 'sonnet') or a",
	"                                        model's full name.",
	"  -n, --name <name>                     Set a display name for this session",
}, "\n")

// resolves is what each alias resolves to on Claude Code 2.1.293.
var resolves = map[string]string{"fable": "claude-fable-5-1", "opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5", "haiku": "claude-haiku-5-5"}

var allIDs = []string{"claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"}

// aProbedClaude is Claude Code 2.1.293 as the mac mini runs it: an alias it resolves answers its probe with the exact id in modelUsage, beside helper when set; a refused one is unrecognized; any other fails otherwise. Every command it is given is kept.
type aProbedClaude struct {
	resolves map[string]string
	refused  []string
	help     string
	helper   string
	calls    []detection.Command
}

func (c *aProbedClaude) run(_ context.Context, command detection.Command) detection.Ran {
	c.calls = append(c.calls, command)
	switch command.Args[0] {
	case "--version":
		return detection.Ran{Stdout: "2.1.293 (Claude Code)\n"}
	case "--help":
		return detection.Ran{Stdout: c.help}
	}
	alias := command.Args[slices.Index(command.Args, "--model")+1]
	if slices.Contains(c.refused, alias) {
		return detection.Ran{Status: 1, Stderr: `[claude-code:unrecognized_model] {"model":"` + alias + `"}`}
	}
	if id, ok := c.resolves[alias]; ok {
		usage := map[string]any{id: map[string]int{"inputTokens": 9}}
		if c.helper != "" {
			usage[c.helper] = map[string]int{"inputTokens": 3}
		}
		text, _ := json.Marshal(map[string]any{"type": "result", "result": "OK", "modelUsage": usage})
		return detection.Ran{Stdout: string(text)}
	}
	return detection.Ran{Status: 1, Stderr: "API Error: Connection error."}
}

func aClaudeCode() *aProbedClaude {
	return &aProbedClaude{resolves: resolves, help: help}
}

func (c *aProbedClaude) detector() Detector {
	return Detector{Run: c.run, NeutralFolder: func() (string, error) { return neutralFolder, nil }}
}

func (c *aProbedClaude) detect(t *testing.T, version string, previous *detection.Harness) detection.Harness {
	t.Helper()
	found, ok := c.detector().Detect(context.Background(), version, previous, detectedNow)
	if !ok {
		t.Fatalf("Detect(%s) found nothing, want a detection", version)
	}
	return found
}

func modelIDs(found detection.Harness) []string {
	model, ok := found.Options[detection.ModelOption]
	if !ok {
		return nil
	}
	return model.Names()
}

func TestClaudeCodesVersionIsReadFromVersion(t *testing.T) {
	version, ok := aClaudeCode().detector().Version(context.Background())

	if version != "2.1.293" || !ok {
		t.Errorf("Version() = %q, %v, want 2.1.293", version, ok)
	}
}

func TestClaudeCodeSaysNoVersionWhenVersionFails(t *testing.T) {
	detector := Detector{Run: func(context.Context, detection.Command) detection.Ran { return detection.Ran{Status: 127} }}

	if version, ok := detector.Version(context.Background()); ok {
		t.Errorf("Version() = %q, want none", version)
	}
}

func TestEachAliasHelpNamesIsProbedOnceFromTheNeutralFolderWithAShortPrintModeTurnWithinAMinute(t *testing.T) {
	claude := aClaudeCode()

	claude.detect(t, "2.1.293", nil)

	var probes []detection.Command
	for _, call := range claude.calls {
		if call.Args[0] == "-p" {
			probes = append(probes, call)
		}
	}
	var want []detection.Command
	for _, alias := range []string{"fable", "opus", "sonnet", "haiku"} {
		want = append(want, detection.Command{Program: "claude", Args: []string{"-p", "--model", alias, "--max-turns", "1", "--output-format", "json", "Reply OK"}, Dir: neutralFolder, Timeout: time.Minute})
	}
	if !reflect.DeepEqual(probes, want) {
		t.Errorf("probes = %v, want %v", probes, want)
	}
}

func TestClaudeCodeDeclaresTheExactIDEachAliasResolvesToAndTheEffortLevelsWithNoDefault(t *testing.T) {
	found := aClaudeCode().detect(t, "2.1.293", nil)

	now := detection.Timestamp(detectedNow)
	want := detection.Harness{Version: "2.1.293", DetectedAt: now, ConfirmedAt: &now, Options: map[string]config.Option{
		"model":  detection.OptionOf(allIDs, "--model"),
		"effort": detection.OptionOf([]string{"low", "medium", "high", "xhigh", "max"}, "--effort"),
	}}
	if !reflect.DeepEqual(found, want) {
		t.Errorf("Detect() = %+v, want %+v", found, want)
	}
}

func TestClaudeCodesAliasesAndEffortLevelsAreReadFromHelpThatWraps(t *testing.T) {
	claude := aClaudeCode()
	claude.help = wrappedHelp

	found := claude.detect(t, "2.1.295", nil)

	if got := modelIDs(found); !slices.Equal(got, allIDs) {
		t.Errorf("models = %v, want %v", got, allIDs)
	}
	if got := found.Options["effort"].Names(); !slices.Equal(got, []string{"low", "medium", "high", "xhigh", "max"}) {
		t.Errorf("effort = %v, want low to max", got)
	}
}

func TestClaudeCodesPermissionModesAreReadFromHelpAndNoneWhenItListsNone(t *testing.T) {
	claude := aClaudeCode()
	claude.help = strings.Join([]string{
		help,
		"  --permission-mode <mode>              Permission mode to use for the session",
		`                                        (choices: "acceptEdits", "auto",`,
		`                                        "bypassPermissions", "manual",`,
		`                                        "dontAsk", "plan")`,
		"  --plugin-dir <path>                   Load plugins from a directory",
	}, "\n")

	found := claude.detect(t, "2.1.296", nil)
	without := aClaudeCode().detect(t, "2.1.293", nil)

	if want := []string{"acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"}; !slices.Equal(found.PermissionModes, want) {
		t.Errorf("permission modes = %v, want %v", found.PermissionModes, want)
	}
	if without.PermissionModes != nil {
		t.Errorf("permission modes = %v, want none", without.PermissionModes)
	}
}

func TestTheIDThatNamesItsAliasIsTakenWhenTheProbeUsedAnotherModelBesideIt(t *testing.T) {
	claude := aClaudeCode()
	claude.helper = "claude-compactor-1"

	if got := modelIDs(claude.detect(t, "2.1.293", nil)); !slices.Equal(got, allIDs) {
		t.Errorf("models = %v, want %v", got, allIDs)
	}
}

func TestAnAliasTheCLIRefusesAsUnrecognizedIsLeftOut(t *testing.T) {
	claude := aClaudeCode()
	claude.refused = []string{"fable"}

	if got, want := modelIDs(claude.detect(t, "2.1.293", nil)), []string{"claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"}; !slices.Equal(got, want) {
		t.Errorf("models = %v, want %v", got, want)
	}
}

func TestAnAliasWhoseProbeNeitherConfirmsNorRefusesKeepsTheIDItResolvedToBeforeAtTheSameVersion(t *testing.T) {
	before := detection.Timestamp(detectedBefore)
	previous := detection.Harness{Version: "2.1.293", DetectedAt: before, ConfirmedAt: &before, Options: map[string]config.Option{"model": detection.OptionOf([]string{"claude-opus-5-5", "claude-fable-5-1"}, "--model")}}
	claude := aClaudeCode()
	claude.resolves, claude.refused = map[string]string{}, []string{"fable"}

	found := claude.detect(t, "2.1.293", &previous)

	if got := modelIDs(found); !slices.Equal(got, []string{"claude-opus-5-5"}) {
		t.Errorf("models = %v, want claude-opus-5-5", got)
	}
	if found.ConfirmedAt == nil || *found.ConfirmedAt != before {
		t.Errorf("confirmed at %v, want %s", found.ConfirmedAt, before)
	}
}

func TestNoIDResolvedAtAnotherVersionIsKeptAndNoModelIsDeclaredWhenNoneResolves(t *testing.T) {
	before := detection.Timestamp(detectedBefore)
	previous := detection.Harness{Version: "2.1.200", DetectedAt: before, ConfirmedAt: &before, Options: map[string]config.Option{"model": detection.OptionOf([]string{"claude-opus-5-5"}, "--model")}}
	claude := aClaudeCode()
	claude.resolves = map[string]string{}

	found := claude.detect(t, "2.1.293", &previous)

	if _, ok := found.Options["model"]; ok || found.ConfirmedAt != nil {
		t.Errorf("Detect() = %+v, want no model and none confirmed", found)
	}
}

func TestTheKnownFamiliesAreProbedAndDeclaredWhenHelpNamesNoAlias(t *testing.T) {
	claude := aClaudeCode()
	claude.help = "  --effort <level>  Effort level (low, high)"

	if got := modelIDs(claude.detect(t, "2.1.293", nil)); !slices.Equal(got, allIDs) {
		t.Errorf("models = %v, want %v", got, allIDs)
	}
}

func TestNoModelIsDeclaredWhenHelpNamesNoAliasAndNoKnownFamilyResolvesAndTheProblemSaysWhy(t *testing.T) {
	claude := aClaudeCode()
	claude.resolves = map[string]string{}
	claude.help = "  --effort <level>  Effort level (low, high)"

	found := claude.detect(t, "2.1.293", nil)

	if _, ok := found.Options["model"]; ok {
		t.Errorf("options = %v, want no model", found.Options)
	}
	if want := "Claude Code 2.1.293's --help names no model alias, so this machine declares no Claude Code model until an update of Claude Code names one"; found.Problem != want {
		t.Errorf("problem = %q, want %q", found.Problem, want)
	}
}

func TestNoEffortIsDeclaredWhenHelpNamesNoLevels(t *testing.T) {
	claude := aClaudeCode()
	claude.help = "  --model <model>  Model (e.g. 'opus')"

	if found := claude.detect(t, "2.1.293", nil); found.Options["effort"].Values != nil {
		t.Errorf("effort = %v, want none", found.Options["effort"])
	}
}
