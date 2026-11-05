package codex

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/usage"
)

// On the session log (rollout file) of a real Codex session today's trierarch is tested on, kept to its session start, turns and token counts, every text elided (#353).
// Codex documents no format for them: when a recapture on a newer Codex fails here, its format changed, and the reader must follow it.

const (
	usageFolder = "/home/operator/ship"
	rollout     = "rollout-2026-10-15T19-04-09-01a14085-6f83-7763-ab56-8681c4557c43.jsonl"
)

var day = filepath.Join("2026", "10", "15")

func capturedTokens(t *testing.T) string {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "trierarch", "test", "logs", "codex-tokens.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func writeLog(t *testing.T, sessions string, name string, text string) {
	t.Helper()
	path := filepath.Join(sessions, day, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func utc(text string) time.Time {
	parsed, err := time.Parse(time.RFC3339, text)
	if err != nil {
		panic(err)
	}
	return parsed
}

func aUsage(sessions string, madeAt string) *Usage {
	return &Usage{Sessions: sessions, MadeAt: func(string) (time.Time, error) { return utc(madeAt), nil }}
}

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

const meta = `{"timestamp":"2026-10-15T17:09:00.000Z","type":"session_meta","payload":{"timestamp":"2026-10-15T17:09:00.000Z","cwd":"/home/operator/ship"}}`

func turn(model string) string {
	return `{"timestamp":"2026-10-15T17:10:00.000Z","type":"turn_context","payload":{"model":"` + model + `"}}`
}

func counted(total string, at string) string {
	return `{"timestamp":"` + at + `","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":` + total + `,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0}}}}`
}

func lines(each ...string) string {
	return strings.Join(each, "\n") + "\n"
}

func TestACodexShipsTokensAreEachModelItsFoldersSessionsUsedInputWithoutWhatWasReadFromTheCache(t *testing.T) {
	sessions := t.TempDir()
	writeLog(t, sessions, rollout, capturedTokens(t))

	got := perModel(mustTokensOf(t, aUsage(sessions, "2026-10-15T00:00:00Z"), usage.Ship{ShipID: "shp_ship", Folder: usageFolder}))

	if want := []usage.HourTokens{{Model: "gpt-6.1-sol", Tokens: usage.Tokens{Input: 43_216, Output: 1428, CacheRead: 250_240}}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("tokens = %+v, want %+v", got, want)
	}
}

func TestACodexShipLeavesOutTheSessionsOfAnotherFolderAndThoseStartedBeforeItsFolderWasMade(t *testing.T) {
	sessions := t.TempDir()
	writeLog(t, sessions, "rollout-other.jsonl", strings.Replace(capturedTokens(t), `"cwd":"`+usageFolder+`"`, `"cwd":"/home/operator/other"`, 1))
	writeLog(t, sessions, rollout, capturedTokens(t))

	if got := mustTokensOf(t, aUsage(sessions, "2026-10-15T18:00:00Z"), usage.Ship{ShipID: "shp_ship", Folder: usageFolder}); len(got) != 0 {
		t.Fatalf("tokens = %+v, want none", got)
	}
}

func TestACodexTurnGivesItsTokensToTheModelOfThatTurn(t *testing.T) {
	sessions := t.TempDir()
	writeLog(t, sessions, "rollout-switch.jsonl", lines(meta, turn("gpt-6.1-sol"), counted("100", "2026-10-15T17:10:01.000Z"), turn("gpt-6-luna"), counted("130", "2026-10-15T17:10:01.000Z"), counted("130", "2026-10-15T17:10:01.000Z")))

	got := perModel(mustTokensOf(t, aUsage(sessions, "2026-10-15T00:00:00Z"), usage.Ship{ShipID: "shp_ship", Folder: usageFolder}))

	want := []usage.HourTokens{{Model: "gpt-6-luna", Tokens: usage.Tokens{Input: 30}}, {Model: "gpt-6.1-sol", Tokens: usage.Tokens{Input: 100}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tokens = %+v, want %+v", got, want)
	}
}

func TestACodexTurnCountsInTheUTCHourItsTokenCountWasWritten(t *testing.T) {
	sessions := t.TempDir()
	writeLog(t, sessions, "rollout-hours.jsonl", lines(meta, turn("gpt-6.1-sol"), counted("100", "2026-10-15T17:59:59.000Z"), counted("130", "2026-10-15T18:00:00.000Z")))

	got := mustTokensOf(t, aUsage(sessions, "2026-10-15T00:00:00Z"), usage.Ship{ShipID: "shp_ship", Folder: usageFolder})

	want := []usage.HourTokens{
		{Model: "gpt-6.1-sol", Hour: utc("2026-10-15T17:00:00Z"), Tokens: usage.Tokens{Input: 100}},
		{Model: "gpt-6.1-sol", Hour: utc("2026-10-15T18:00:00Z"), Tokens: usage.Tokens{Input: 30}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tokens = %+v, want %+v", got, want)
	}
}

func TestACodexTokenCountCountsToTheLoginOfTheSessionThatWroteIt(t *testing.T) {
	sessions := t.TempDir()
	writeLog(t, sessions, "rollout-resumed.jsonl", lines(meta, turn("gpt-6.1-sol"), counted("100", "2026-10-15T17:10:01.000Z"), counted("130", "2026-10-15T17:20:01.000Z")))
	logins := &usage.Logins{Login: "apiKey", Earlier: []reconciler.EarlierLogin{{Login: "subscription", Until: "2026-10-15T17:15:00.000Z"}}}

	got := perModel(mustTokensOf(t, aUsage(sessions, "2026-10-15T00:00:00Z"), usage.Ship{ShipID: "shp_ship", Folder: usageFolder, Logins: logins}))

	want := []usage.HourTokens{{Model: "gpt-6.1-sol", Login: "apiKey", Tokens: usage.Tokens{Input: 30}}, {Model: "gpt-6.1-sol", Login: "subscription", Tokens: usage.Tokens{Input: 100}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tokens = %+v, want %+v", got, want)
	}
}

func TestACodexSessionLogIsReadOnFromWhereTheLastReadEnded(t *testing.T) {
	sessions := t.TempDir()
	writeLog(t, sessions, "rollout-growing.jsonl", lines(meta, turn("gpt-6.1-sol"), counted("100", "2026-10-15T17:10:01.000Z")))
	reader := aUsage(sessions, "2026-10-15T00:00:00Z")
	ship := usage.Ship{ShipID: "shp_ship", Folder: usageFolder}
	mustTokensOf(t, reader, ship)
	file, err := os.OpenFile(filepath.Join(sessions, day, "rollout-growing.jsonl"), os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(counted("130", "2026-10-15T17:20:01.000Z") + "\n"); err != nil {
		t.Fatal(err)
	}
	file.Close()

	got := perModel(mustTokensOf(t, reader, ship))

	if want := []usage.HourTokens{{Model: "gpt-6.1-sol", Tokens: usage.Tokens{Input: 130}}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("tokens = %+v, want %+v", got, want)
	}
}

func TestCodexsSubscriptionIsHowMuchOfItsWindowsTheNewestLogsLastTokenCountSaysIsUsed(t *testing.T) {
	sessions := t.TempDir()
	writeLog(t, sessions, "rollout-2026-10-14T08-00-00-old.jsonl", strings.ReplaceAll(capturedTokens(t), `"used_percent":2.0`, `"used_percent":99.0`))
	writeLog(t, sessions, rollout, capturedTokens(t))

	got, err := aUsage(sessions, "2026-10-15T00:00:00Z").Subscription()
	if err != nil {
		t.Fatal(err)
	}

	want := []usage.Window{
		{WindowMinutes: 300, UsedPercent: 2, ResetsAt: utc("2026-10-15T22:04:13Z")},
		{WindowMinutes: 10_080, UsedPercent: 0, ResetsAt: utc("2026-10-22T17:04:13Z")},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Subscription = %+v, want %+v", got, want)
	}
}

func TestCodexsSubscriptionIsNoneBeforeCodexWroteAnySessionLog(t *testing.T) {
	got, err := aUsage(t.TempDir(), "2026-10-15T00:00:00Z").Subscription()
	if err != nil || got != nil {
		t.Fatalf("Subscription = %+v, %v, want none", got, err)
	}
}
