package cli

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/servicelog"
)

const (
	actionLine  = `{"time":"2026-10-06T15:00:00.000Z","shipId":"shp_1","shipName":"scout","action":"crew","outcome":"crewed"}`
	failureLine = `{"time":"2026-10-06T15:00:05.000Z","shipId":"shp_1","action":"crew","outcome":"failed: x","next":"the next pass tries again"}`
	warnLine    = `{"time":"2026-10-06T15:00:10.000Z","level":"warn","message":"The loop failed"}`
)

// aServiceLog holds lines, and follows the ones given until stopped.
func aServiceLog(machine *Machine, lines []string, followed ...string) *[]string {
	asked := []string{}
	printed := []string{}
	machine.ServiceLog = func(paths.Paths) servicelog.Log {
		return servicelog.Log{
			Where: servicelog.Where{Journal: "journalctl --user --unit aeolus-trierarch.service"},
			Tail: func(count int) ([]string, error) {
				asked = append(asked, "tail")
				return lines[max(0, len(lines)-count):], nil
			},
			Follow: func(stop <-chan struct{}, write func(string)) error {
				for _, line := range followed {
					write(line)
				}
				return nil
			},
		}
	}
	machine.Print = func(line string) { printed = append(printed, line) }
	return &printed
}

func TestLogsRendersTheRecordsAndShowsAnyOtherLineAsItIs(t *testing.T) {
	machine, _, _ := aMain(t)
	aServiceLog(&machine, []string{actionLine, failureLine, warnLine, "an older line"})

	output, code := Main([]string{"logs"}, machine)

	want := strings.Join([]string{
		"2026-10-06T15:00:00.000Z shp_1 (scout) crew: crewed",
		"2026-10-06T15:00:05.000Z shp_1 crew: failed: x. Next: the next pass tries again",
		"2026-10-06T15:00:10.000Z warn The loop failed",
		"an older line",
	}, "\n")
	if code != 0 || output != want {
		t.Errorf("answered %q, %d", output, code)
	}
}

func TestLogsGivesTheRecordsAsTheyAreWithJSON(t *testing.T) {
	machine, _, _ := aMain(t)
	aServiceLog(&machine, []string{actionLine, "an older line", `{"time":"t","extra":1}`})

	output, code := Main([]string{"logs", "--json"}, machine)

	var got struct {
		Journal string           `json:"journal"`
		Lines   []map[string]any `json:"lines"`
	}
	if err := json.Unmarshal([]byte(output), &got); err != nil || code != 0 {
		t.Fatalf("answered %q, %d: %v", output, code, err)
	}
	wantAction := map[string]any{"time": "2026-10-06T15:00:00.000Z", "shipId": "shp_1", "shipName": "scout", "action": "crew", "outcome": "crewed"}
	if got.Journal != "journalctl --user --unit aeolus-trierarch.service" || !reflect.DeepEqual(got.Lines, []map[string]any{wantAction, {"line": "an older line"}, {"line": `{"time":"t","extra":1}`}}) {
		t.Errorf("gave %+v", got)
	}
}

func TestLogsSaysItHoldsNoLineYet(t *testing.T) {
	machine, _, _ := aMain(t)
	aServiceLog(&machine, nil)

	output, code := Main([]string{"logs"}, machine)

	if code != 0 || output != "No log lines yet in the journal (journalctl --user --unit aeolus-trierarch.service)." {
		t.Errorf("answered %q, %d", output, code)
	}
}

func TestLogsShowsTheLastFiftyLinesOrTheLastLinesAsked(t *testing.T) {
	machine, _, _ := aMain(t)
	lines := []string{}
	for index := 1; index <= 60; index++ {
		lines = append(lines, "line "+string(rune('A'+index%26))+strings.Repeat("x", index))
	}
	aServiceLog(&machine, lines)

	byDefault, _ := Main([]string{"logs"}, machine)
	few, _ := Main([]string{"logs", "--lines", "2"}, machine)
	inline, _ := Main([]string{"logs", "--lines=1", "--json"}, machine)

	if got := strings.Split(byDefault, "\n"); len(got) != 50 || got[0] != lines[10] {
		t.Errorf("showed %d lines from %q", len(got), got[0])
	}
	if few != lines[58]+"\n"+lines[59] || !strings.Contains(inline, lines[59]) || strings.Contains(inline, lines[58]) {
		t.Errorf("showed %q and %q", few, inline)
	}
}

func TestLogsRefusesALinesThatIsNoWholeNumber(t *testing.T) {
	machine, _, _ := aMain(t)
	aServiceLog(&machine, []string{"one"})

	for _, lines := range []string{"many", "2.5", "-1", "NaN", "Infinity"} {
		output, code := Main([]string{"logs", "--lines", lines}, machine)
		if code != 1 || output != "--lines takes a whole number" {
			t.Errorf("%s: answered %q, %d", lines, output, code)
		}
		json, code := Main([]string{"logs", "--lines", lines, "--json"}, machine)
		if code != 1 || !reflect.DeepEqual(decoded(t, json), map[string]any{"error": "--lines takes a whole number"}) {
			t.Errorf("%s: answered %q, %d", lines, json, code)
		}
	}
	if output, code := Main([]string{"logs", "--lines", "1e1"}, machine); code != 0 || output != "one" {
		t.Errorf("1e1: answered %q, %d", output, code)
	}
}

func TestLogsSaysWhyTheLogCannotBeRead(t *testing.T) {
	machine, _, _ := aMain(t)
	machine.ServiceLog = func(paths.Paths) servicelog.Log {
		return servicelog.Log{Tail: func(int) ([]string, error) { return nil, errors.New("journalctl failed: no journal") }}
	}

	output, code := Main([]string{"logs"}, machine)

	if code != 1 || output != "journalctl failed: no journal" {
		t.Errorf("answered %q, %d", output, code)
	}
}

func TestLogsFollowPrintsTheLastLinesThenEachLineFollowedAndAnswersNothingMore(t *testing.T) {
	machine, _, _ := aMain(t)
	printed := aServiceLog(&machine, []string{"older", actionLine}, warnLine, "plain")

	output, code := Main([]string{"logs", "--follow", "--lines", "1"}, machine)

	want := []string{"2026-10-06T15:00:00.000Z shp_1 (scout) crew: crewed", "2026-10-06T15:00:10.000Z warn The loop failed", "plain"}
	if code != 0 || output != "" || !reflect.DeepEqual(*printed, want) {
		t.Errorf("answered %q, %d after printing %q", output, code, *printed)
	}
}

func TestLogsFollowWithJSONPrintsEachLineAsOneObject(t *testing.T) {
	machine, _, _ := aMain(t)
	printed := aServiceLog(&machine, []string{actionLine}, "a <plain> line")

	output, code := Main([]string{"logs", "--follow", "--json"}, machine)

	want := []string{actionLine, `{"line":"a <plain> line"}`}
	if code != 0 || output != "" || !reflect.DeepEqual(*printed, want) {
		t.Errorf("answered %q, %d after printing %q", output, code, *printed)
	}
}
