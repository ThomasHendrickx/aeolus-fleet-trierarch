package claudecode

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/usage"
)

// On the transcripts of Claude Code 2.1.29x and a print-mode turn of 2.1.306 today's trierarch is tested on, captured from real sessions, every text elided (#353).
// Claude Code documents no format for them: when a recapture on a newer Claude Code fails here, its format changed, and the reader must follow it.

const usageFolder = "/home/thomas/.aeolus/trierarch/worktrees/aeolus-fleet/scout"

// usageProject is Claude Code's name for the folder's conversations: every character other than a letter or digit as a dash.
const usageProject = "-home-thomas--aeolus-trierarch-worktrees-aeolus-fleet-scout"

func capturedLog(t *testing.T, name string) []byte {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "trierarch", "test", "logs", name))
	if err != nil {
		t.Fatal(err)
	}
	return text
}

func writeFile(t *testing.T, path string, text []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, text, 0o644); err != nil {
		t.Fatal(err)
	}
}

// withConversations gives the ship's folder the captured conversation, and a sub-agent of it the captured sub-agent's.
func withConversations(t *testing.T, projects string) {
	t.Helper()
	writeFile(t, filepath.Join(projects, usageProject, "e5346dbb.jsonl"), capturedLog(t, "claude-code-session.jsonl"))
	writeFile(t, filepath.Join(projects, usageProject, "e5346dbb", "subagents", "agent-a7aea085efb2f4eff.jsonl"), capturedLog(t, "claude-code-subagent.jsonl"))
}

func utc(text string) time.Time {
	parsed, err := time.Parse(time.RFC3339, text)
	if err != nil {
		panic(err)
	}
	return parsed
}

func aUsage(projects string, madeAt string, probe detection.Ran) *Usage {
	return &Usage{
		Projects:      projects,
		MadeAt:        func(string) (time.Time, error) { return utc(madeAt), nil },
		Run:           func(context.Context, detection.Command) detection.Ran { return probe },
		NeutralFolder: func() (string, error) { return os.MkdirTemp("", "aeolus-probe-test-") },
	}
}

var notLoggedIn = detection.Ran{Status: 1, Stderr: "not logged in"}

// perModel is what the reader counted, added up per model and login over the hours, as the report gives it.
func perModel(counted []usage.HourTokens) []usage.HourTokens {
	var summed []usage.HourTokens
	for _, each := range counted {
		each.Hour = time.Time{}
		found := false
		for at := range summed {
			if summed[at].Model == each.Model && summed[at].Login == each.Login {
				summed[at].Tokens = summed[at].Tokens.Plus(each.Tokens)
				found = true
			}
		}
		if !found {
			summed = append(summed, each)
		}
	}
	return summed
}

func mustTokensOf(t *testing.T, reader *Usage, ship usage.Ship) []usage.HourTokens {
	t.Helper()
	counted, err := reader.TokensOf(ship)
	if err != nil {
		t.Fatal(err)
	}
	return counted
}

var (
	opus   = usage.HourTokens{Model: "claude-opus-5-5", Tokens: usage.Tokens{Input: 16, Output: 1687, CacheRead: 326_051, CacheWrite: 68_515}}
	sonnet = usage.HourTokens{Model: "claude-sonnet-5-5", Tokens: usage.Tokens{Input: 8, Output: 988, CacheRead: 143_335, CacheWrite: 52_804}}
)

func TestAClaudeCodeShipsTokensAreEachModelItsConversationsAndTheirSubAgentsUsedEachMessageOnce(t *testing.T) {
	projects := t.TempDir()
	withConversations(t, projects)

	got := perModel(mustTokensOf(t, aUsage(projects, "2026-10-09T00:00:00Z", notLoggedIn), usage.Ship{ShipID: "shp_scout", Folder: usageFolder}))

	if want := []usage.HourTokens{opus, sonnet}; !reflect.DeepEqual(got, want) {
		t.Fatalf("tokens = %+v, want %+v", got, want)
	}
}

func TestAClaudeCodeShipCountsOnlyWhatWasUsedSinceItsFolderWasMade(t *testing.T) {
	projects := t.TempDir()
	withConversations(t, projects)

	got := perModel(mustTokensOf(t, aUsage(projects, "2026-10-09T16:00:00Z", notLoggedIn), usage.Ship{ShipID: "shp_scout", Folder: usageFolder}))

	want := []usage.HourTokens{{Model: "claude-opus-5-5", Tokens: usage.Tokens{Input: 4, Output: 400, CacheRead: 25_945, CacheWrite: 34_622}}, sonnet}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tokens = %+v, want %+v", got, want)
	}
}

func TestAClaudeCodeMessageCountsToTheLoginOfTheSessionThatWroteIt(t *testing.T) {
	projects := t.TempDir()
	withConversations(t, projects)
	logins := &usage.Logins{Login: "apiKey", Earlier: []reconciler.EarlierLogin{{Login: "subscription", Until: "2026-10-09T16:00:00.000Z"}}}

	got := perModel(mustTokensOf(t, aUsage(projects, "2026-10-09T00:00:00Z", notLoggedIn), usage.Ship{ShipID: "shp_scout", Folder: usageFolder, Logins: logins}))

	withSonnet := sonnet
	withSonnet.Login = "apiKey"
	want := []usage.HourTokens{
		{Model: "claude-opus-5-5", Login: "apiKey", Tokens: usage.Tokens{Input: 4, Output: 400, CacheRead: 25_945, CacheWrite: 34_622}},
		{Model: "claude-opus-5-5", Login: "subscription", Tokens: usage.Tokens{Input: 12, Output: 1287, CacheRead: 300_106, CacheWrite: 33_893}},
		withSonnet,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tokens = %+v, want %+v", got, want)
	}
}

func TestAClaudeCodeConversationAddsWhatItWroteSinceTheLastReadALineOnceItIsWhole(t *testing.T) {
	projects := t.TempDir()
	withConversations(t, projects)
	reader := aUsage(projects, "2026-10-09T00:00:00Z", notLoggedIn)
	ship := usage.Ship{ShipID: "shp_scout", Folder: usageFolder}
	mustTokensOf(t, reader, ship)
	line := `{"type":"assistant","timestamp":"2026-10-10T08:00:00.000Z","message":{"id":"msg_new","model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}}}`
	transcript := filepath.Join(projects, usageProject, "e5346dbb.jsonl")

	appendText(t, transcript, line[:40])
	half := perModel(mustTokensOf(t, reader, ship))[0]
	appendText(t, transcript, line[40:]+"\n")
	whole := perModel(mustTokensOf(t, reader, ship))[0]

	if half != opus {
		t.Errorf("with half a line = %+v, want %+v", half, opus)
	}
	if want := (usage.HourTokens{Model: "claude-opus-5-5", Tokens: usage.Tokens{Input: 17, Output: 1689, CacheRead: 326_054, CacheWrite: 68_519}}); whole != want {
		t.Errorf("with the line whole = %+v, want %+v", whole, want)
	}
}

func appendText(t *testing.T, path string, text string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.WriteString(text); err != nil {
		t.Fatal(err)
	}
}

func TestAClaudeCodeMessageCountsInTheUTCHourItsTranscriptSaysItWasWritten(t *testing.T) {
	projects := t.TempDir()
	withConversations(t, projects)

	got := mustTokensOf(t, aUsage(projects, "2026-10-09T00:00:00Z", notLoggedIn), usage.Ship{ShipID: "shp_scout", Folder: usageFolder})

	withHour := sonnet
	withHour.Hour = utc("2026-10-22T12:00:00Z")
	want := []usage.HourTokens{
		{Model: "claude-opus-5-5", Hour: utc("2026-10-09T15:00:00Z"), Tokens: usage.Tokens{Input: 12, Output: 1287, CacheRead: 300_106, CacheWrite: 33_893}},
		{Model: "claude-opus-5-5", Hour: utc("2026-10-09T17:00:00Z"), Tokens: usage.Tokens{Input: 4, Output: 400, CacheRead: 25_945, CacheWrite: 34_622}},
		withHour,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tokens = %+v, want %+v", got, want)
	}
}

func TestAFolderClaudeCodeHasNoConversationOfHasNoTokens(t *testing.T) {
	if got := mustTokensOf(t, aUsage(t.TempDir(), "2026-10-09T00:00:00Z", notLoggedIn), usage.Ship{ShipID: "shp_scout", Folder: usageFolder}); len(got) != 0 {
		t.Fatalf("tokens = %+v, want none", got)
	}
}

func TestClaudeCodesSubscriptionIsItsFiveHourAndSevenDayWindowsAsAShortPrintModeTurnStreamsThem(t *testing.T) {
	var asked []detection.Command
	reader := aUsage(t.TempDir(), "2026-10-09T00:00:00Z", detection.Ran{Stdout: string(capturedLog(t, "claude-code-usage-probe.jsonl"))})
	run := reader.Run
	reader.Run = func(ctx context.Context, command detection.Command) detection.Ran {
		asked = append(asked, command)
		return run(ctx, command)
	}

	got, err := reader.Subscription()
	if err != nil {
		t.Fatal(err)
	}

	want := []usage.Window{
		{WindowMinutes: 300, UsedPercent: 9, ResetsAt: utc("2026-10-25T01:20:00Z")},
		{WindowMinutes: 10_080, UsedPercent: 70, ResetsAt: utc("2026-10-28T00:00:00Z")},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Subscription = %+v, want %+v", got, want)
	}
	if len(asked) != 1 || strings.Join(asked[0].Args, " ") != "-p --model haiku --max-turns 1 --output-format stream-json --verbose Reply OK" || asked[0].Dir == "" {
		t.Fatalf("ran %+v, want one short turn on haiku from a neutral folder", asked)
	}
	if _, err := os.Stat(asked[0].Dir); !os.IsNotExist(err) {
		t.Errorf("the neutral folder %s is still there", asked[0].Dir)
	}
}

func TestClaudeCodesSubscriptionIsNoneWhenTheTurnSaysNothingOfItsWindows(t *testing.T) {
	got, err := aUsage(t.TempDir(), "2026-10-09T00:00:00Z", notLoggedIn).Subscription()
	if err != nil || got != nil {
		t.Fatalf("Subscription = %+v, %v, want none", got, err)
	}
}
