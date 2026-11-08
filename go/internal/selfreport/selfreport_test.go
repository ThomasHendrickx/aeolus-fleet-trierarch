package selfreport

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/failedstarts"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/machineload"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/trust"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/usage"
)

const scout = "shp_01m6jyczpnpp5c0vxh54c966cy"

func aConfiguration() config.Configuration {
	configuration := config.Initial()
	configuration.Caps = config.Caps{Ships: 6, Running: 4}
	configuration.Repositories = map[string]config.Repository{"aeolus-fleet": {Path: "/repos/aeolus-fleet"}}
	configuration.Folders = map[string]config.Folder{"notes": {Path: "/notes"}}
	configuration.Harnesses = map[string]config.Harness{"claude-code": {Flags: []string{"--dangerously-skip-permissions"}, Options: map[string]config.Option{"effort": {Values: map[string][]string{"low": nil, "high": nil}, Default: "low", Order: []string{"low", "high"}}}}}
	return configuration
}

func anInput() Input {
	return Input{Configuration: aConfiguration(), Harnesses: []string{"claude-code"}, Trusted: map[string]trust.Places{"claude-code": {Repositories: []string{"aeolus-fleet"}, Folders: []string{"notes"}}}, State: reconciler.Empty(), Version: "0.40.0", OS: "darwin", Arch: "arm64"}
}

// asJSON is the report as the fleet receives it.
func asJSON(t *testing.T, report Report) map[string]any {
	t.Helper()
	text, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(text, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func detailsJSON(t *testing.T, in Input) map[string]any {
	t.Helper()
	return asJSON(t, Of(in))["details"].(map[string]any)
}

func TestIdleWithNoSessionRunning(t *testing.T) {
	report := Of(anInput())
	if report.State != "idle" || report.Note != "0 of 6 running" {
		t.Fatalf("report = %s, %q; want idle, \"0 of 6 running\"", report.State, report.Note)
	}
}

func TestWorkingWhileASessionRuns(t *testing.T) {
	in := anInput()
	in.Running = 2
	report := Of(in)
	if report.State != "working" || report.Note != "2 of 6 running" {
		t.Fatalf("report = %s, %q; want working, \"2 of 6 running\"", report.State, report.Note)
	}
}

func TestTheNoteCountsCrashedShips(t *testing.T) {
	in := anInput()
	in.State.Entries = map[string]reconciler.Entry{scout: {ShipID: scout, State: "crashed"}}
	if got := Of(in).Note; got != "0 of 6 running, 1 crashed" {
		t.Fatalf("note = %q", got)
	}
}

func TestTheNoteSaysWhyHostSessionsGetNoAip(t *testing.T) {
	in := anInput()
	in.AipMissing = "its install failed, as aeolus-trierarch status says"
	if got := Of(in).Note; got != "0 of 6 running, no aip on the host: its install failed, as aeolus-trierarch status says" {
		t.Fatalf("note = %q", got)
	}
}

// aCrowdedInput is a report whose note says a lot already: 196 characters, before any aip.
func aCrowdedInput() Input {
	in := anInput()
	in.IsKeyCutOff = true
	in.Running = 1
	in.State.Entries = map[string]reconciler.Entry{}
	for at := range 6 {
		shipID := fmt.Sprintf("shp_01m6jyczpnpp5c0vxh54c966c%d", at)
		in.State.Entries[shipID] = reconciler.Entry{ShipID: shipID, State: "crashed"}
	}
	in.State.NotOffered = []reconciler.NotOfferedHarness{{Harness: "copilot", Reason: "its aeolus-fleet plugin is not installed for Copilot: copilot plugin install aeolus-fleet@aeolus-fleet"}}
	return in
}

func TestTheNoteSaysNoAipWithoutWhyWhereWhyWouldPassTheLongestNoteCoreTakes(t *testing.T) {
	in := aCrowdedInput()
	in.IsKeyCutOff = false
	in.AipMissing = "its install failed, as aeolus-trierarch status says"

	note := Of(in).Note

	if !strings.HasSuffix(note, ", no aip on the host") || len(note) > 200 {
		t.Fatalf("note = %q (%d characters), want it ending in no aip on the host, within 200", note, len(note))
	}
}

func TestTheNoteLeavesOutTheAipWhereItWouldPassTheLongestNoteCoreTakes(t *testing.T) {
	in := aCrowdedInput()
	in.AipMissing = "its install failed, as aeolus-trierarch status says"

	note := Of(in).Note

	if len(note) > 200 || strings.Contains(note, "aip") || !strings.Contains(note, "copilot not offered") {
		t.Fatalf("note = %q (%d characters), want the rest within 200 and no aip", note, len(note))
	}
}

func TestBlockedWhileTheFleetsKeyIsCutOff(t *testing.T) {
	in := anInput()
	in.Running = 1
	in.IsKeyCutOff = true
	report := Of(in)
	want := "1 of 6 running, waiting for the fleet's key (KEY_UNAVAILABLE)"
	if report.State != "blocked" || report.Note != want {
		t.Fatalf("report = %s, %q; want blocked, %q", report.State, report.Note, want)
	}
}

func TestDetailsSayWhatTheMachineOffers(t *testing.T) {
	confirmed := "2026-10-08T15:00:00.000Z"
	in := anInput()
	in.Detected = detection.Detected{"claude-code": {Version: "2.1.293", ConfirmedAt: &confirmed}}
	in.Logins = aLogins{keys: map[string][2]string{"claude-code": {"outOfCredit", "2026-10-28T14:02:00.000Z"}}}
	in.Configuration.Logins = &config.Logins{Default: &config.DefaultLogins{ClaudeCode: "apiKey"}}
	in.Configuration.Runtime = &config.Runtime{Kind: "container"}

	got := detailsJSON(t, in)

	want := `{
	  "harnesses": [{
	    "harness": "claude-code",
	    "options": {"type": "object", "properties": {"effort": {"enum": ["low", "high"], "default": "low"}}, "additionalProperties": false},
	    "flags": ["--dangerously-skip-permissions"],
	    "riskyFlags": ["--dangerously-skip-permissions"],
	    "version": "2.1.293",
	    "modelsConfirmedAt": "2026-10-08T15:00:00.000Z",
	    "login": {"default": "apiKey", "key": "outOfCredit", "keyStateAt": "2026-10-28T14:02:00.000Z"}
	  }],
	  "workspaces": {"repositories": ["aeolus-fleet"], "folders": ["notes"]},
	  "caps": {"ships": 6, "running": 4},
	  "kept": [],
	  "orphans": [],
	  "logins": [],
	  "machine": {"os": "macos", "arch": "arm64"},
	  "runtime": "container",
	  "version": "0.40.0"
	}`
	assertJSON(t, got, want)
}

func assertJSON(t *testing.T, got map[string]any, want string) {
	t.Helper()
	var expected map[string]any
	if err := json.Unmarshal([]byte(want), &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, expected) {
		text, _ := json.MarshalIndent(got, "", "  ")
		t.Fatalf("details = %s\nwant %s", text, want)
	}
}

func TestAHarnessNotDetectedSaysNoVersion(t *testing.T) {
	harness := detailsJSON(t, anInput())["harnesses"].([]any)[0].(map[string]any)
	if _, ok := harness["version"]; ok {
		t.Fatalf("harness = %v; want no version", harness)
	}
	if _, ok := harness["modelsConfirmedAt"]; ok {
		t.Fatalf("harness = %v; want no modelsConfirmedAt", harness)
	}
}

func TestAHarnessDetectedButNotConfirmedSaysNull(t *testing.T) {
	in := anInput()
	in.Detected = detection.Detected{"claude-code": {Version: "2.1.293"}}
	harness := detailsJSON(t, in)["harnesses"].([]any)[0].(map[string]any)
	if value, ok := harness["modelsConfirmedAt"]; !ok || value != nil {
		t.Fatalf("modelsConfirmedAt = %v, %v; want null", value, ok)
	}
}

func TestAFlagWithAValueIsRiskyByItsName(t *testing.T) {
	in := anInput()
	in.Configuration.Harnesses["claude-code"] = config.Harness{Flags: []string{"--model=opus", "--dangerously-skip-permissions=true"}}
	harness := detailsJSON(t, in)["harnesses"].([]any)[0].(map[string]any)
	if got := harness["riskyFlags"]; !reflect.DeepEqual(got, []any{"--dangerously-skip-permissions=true"}) {
		t.Fatalf("riskyFlags = %v", got)
	}
}

func TestNoPlaceIsOfferedWithoutAHarness(t *testing.T) {
	in := anInput()
	in.Harnesses = nil
	assertJSON(t, map[string]any{"workspaces": detailsJSON(t, in)["workspaces"]}, `{"workspaces": {"repositories": [], "folders": []}}`)
}

func TestOnlyThePlacesEveryOfferedHarnessTrustsAreOffered(t *testing.T) {
	in := anInput()
	in.Configuration.Repositories["other"] = config.Repository{Path: "/repos/other"}
	in.Configuration.Folders["scratch"] = config.Folder{Path: "/scratch"}
	in.Configuration.Harnesses["codex"] = config.Harness{}
	in.Harnesses = []string{"claude-code", "codex"}
	in.Trusted = map[string]trust.Places{
		"claude-code": {Repositories: []string{"aeolus-fleet", "other"}, Folders: []string{"notes", "scratch"}},
		"codex":       {Repositories: []string{"aeolus-fleet"}, Folders: []string{"scratch"}},
	}

	assertJSON(t, map[string]any{"workspaces": detailsJSON(t, in)["workspaces"]}, `{"workspaces": {"repositories": ["aeolus-fleet"], "folders": ["scratch"]}}`)
}

func TestAHarnessNotOfferedDoesNotHoldBackAPlace(t *testing.T) {
	in := anInput()
	in.Configuration.Harnesses["codex"] = config.Harness{}
	in.Trusted["codex"] = trust.Places{}

	assertJSON(t, map[string]any{"workspaces": detailsJSON(t, in)["workspaces"]}, `{"workspaces": {"repositories": ["aeolus-fleet"], "folders": ["notes"]}}`)
}

func TestAHarnessWithNoTrustReadTrustsNothing(t *testing.T) {
	in := anInput()
	in.Trusted = nil

	assertJSON(t, map[string]any{"workspaces": detailsJSON(t, in)["workspaces"]}, `{"workspaces": {"repositories": [], "folders": []}}`)
}

func TestAnUnknownPlatformIsLeftOutOfTheMachine(t *testing.T) {
	in := anInput()
	in.OS, in.Arch = "plan9", "amd64"
	assertJSON(t, map[string]any{"machine": detailsJSON(t, in)["machine"]}, `{"machine": {"arch": "amd64"}}`)
	in.Arch = "riscv64"
	if _, ok := detailsJSON(t, in)["machine"]; ok {
		t.Fatal("machine reported for a platform and chip nobody labels")
	}
}

func TestKeptWorktreesAndOrphansAreNamedNeverTheirPaths(t *testing.T) {
	in := anInput()
	in.State.Kept = []any{map[string]any{"shipId": scout, "repository": "aeolus-fleet", "path": "/secret/path"}}
	in.State.Orphans = []any{map[string]any{"repository": "aeolus-fleet", "name": "lookout", "path": "/secret/path"}}
	got := detailsJSON(t, in)
	assertJSON(t, map[string]any{"kept": got["kept"], "orphans": got["orphans"]}, `{"kept": [{"shipId": "`+scout+`", "repository": "aeolus-fleet"}], "orphans": [{"repository": "aeolus-fleet", "name": "lookout"}]}`)
}

func TestAShipsLoginIsReportedWithTheOneItsNextStartUses(t *testing.T) {
	in := anInput()
	in.Logins = aLogins{next: map[string]string{"scout": "apiKey"}}
	in.State.Entries = map[string]reconciler.Entry{
		scout:    {ShipID: scout, ShipName: "scout", Harness: "claude-code", Login: "subscription"},
		"shp_02": {ShipID: "shp_02", ShipName: "other", Harness: "claude-code"},
	}
	assertJSON(t, map[string]any{"logins": detailsJSON(t, in)["logins"]}, `{"logins": [{"shipId": "`+scout+`", "login": "subscription", "next": "apiKey"}]}`)
}

type aLogins struct {
	keys map[string][2]string
	next map[string]string
}

func (l aLogins) LoginOf(harness string, shipName string) string {
	if login, ok := l.next[shipName]; ok {
		return login
	}
	return "subscription"
}

func (l aLogins) KeyState(harness string) (string, string) {
	if key, ok := l.keys[harness]; ok {
		return key[0], key[1]
	}
	return "none", ""
}

type aFleet struct {
	reports []Report
	details []any
	err     error
}

func (f *aFleet) ReportSelf(state string, note string, details any) error {
	if f.err != nil {
		return f.err
	}
	f.reports = append(f.reports, Report{State: state, Note: note})
	f.details = append(f.details, details)
	return nil
}

type aStore struct{ state reconciler.State }

func (s *aStore) Load() (reconciler.State, error) { return s.state, nil }

type someSessions struct{ running []sessions.Observed }

func (s *someSessions) List() ([]sessions.Observed, error) { return s.running, nil }

func aReporter() (*Reporter, *aFleet, *someSessions) {
	fleet, running := &aFleet{}, &someSessions{}
	return &Reporter{Fleet: fleet, Store: &aStore{state: reconciler.Empty()}, Sessions: running, Input: anInput}, fleet, running
}

func TestReportsAtStartThenOnlyWhenItWouldDiffer(t *testing.T) {
	reporter, fleet, running := aReporter()
	for range 3 {
		if err := reporter.Report(false); err != nil {
			t.Fatal(err)
		}
	}
	if len(fleet.reports) != 1 {
		t.Fatalf("reports = %d after three unchanged passes; want 1", len(fleet.reports))
	}
	running.running = []sessions.Observed{{ShipID: scout, Status: "running"}}
	if err := reporter.Report(false); err != nil {
		t.Fatal(err)
	}
	if len(fleet.reports) != 2 || fleet.reports[1].State != "working" {
		t.Fatalf("reports = %v; want a second one, working", fleet.reports)
	}
}

func TestAnExitedSessionDoesNotCountAsRunning(t *testing.T) {
	reporter, fleet, running := aReporter()
	running.running = []sessions.Observed{{ShipID: scout, Status: "exited"}}
	if err := reporter.Report(false); err != nil {
		t.Fatal(err)
	}
	if fleet.reports[0].State != "idle" {
		t.Fatalf("state = %s; want idle", fleet.reports[0].State)
	}
}

func TestReportsBlockedWhenTheKeyIsCutOffAndAgainWhenItIsBack(t *testing.T) {
	reporter, fleet, _ := aReporter()
	_ = reporter.Report(true)
	_ = reporter.Report(false)
	if len(fleet.reports) != 2 || fleet.reports[0].State != "blocked" || fleet.reports[1].State != "idle" {
		t.Fatalf("reports = %v; want blocked then idle", fleet.reports)
	}
}

func TestAReportTheFleetRefusedIsSentAgainOnTheNextPass(t *testing.T) {
	reporter, fleet, _ := aReporter()
	fleet.err = errors.New("the fleet cannot be reached")
	if err := reporter.Report(false); err == nil {
		t.Fatal("a failed report was not an error")
	}
	fleet.err = nil
	if err := reporter.Report(false); err != nil {
		t.Fatal(err)
	}
	if len(fleet.reports) != 1 {
		t.Fatalf("reports = %d; want the report sent once the fleet answers", len(fleet.reports))
	}
}

func aLoad(memoryAvailable int64) *machineload.Load {
	return &machineload.Load{
		Memory: machineload.Memory{TotalBytes: 100, AvailableBytes: memoryAvailable},
		Swap:   &machineload.Swap{TotalBytes: 100, UsedBytes: 10},
		CPU:    machineload.CPU{Cores: 4, LoadAverage: 3.5},
		Disk:   machineload.Disk{TotalBytes: 1000, FreeBytes: 250},
	}
}

func TestTheDetailsCarryTheMachinesLoadAsItWasRead(t *testing.T) {
	in := anInput()
	in.Load = aLoad(30)
	want := map[string]any{
		"memory": map[string]any{"totalBytes": 100.0, "availableBytes": 30.0},
		"swap":   map[string]any{"totalBytes": 100.0, "usedBytes": 10.0},
		"cpu":    map[string]any{"cores": 4.0, "loadAverage": 3.5},
		"disk":   map[string]any{"totalBytes": 1000.0, "freeBytes": 250.0},
	}
	if got := detailsJSON(t, in)["load"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("load = %v; want %v", got, want)
	}
}

func TestTheDetailsCarryNoLoadWhileNoneWasRead(t *testing.T) {
	if _, ok := detailsJSON(t, anInput())["load"]; ok {
		t.Fatal("details name a load that was never read")
	}
}

type aLoadReader struct{ load *machineload.Load }

func (r *aLoadReader) Read() (*machineload.Load, bool) { return r.load, false }

func TestTheReportGoesAgainForTheLoadOnlyOnceItTakesAnotherStep(t *testing.T) {
	reporter, fleet, _ := aReporter()
	loads := &aLoadReader{load: aLoad(30)}
	reporter.Load = loads
	for _, available := range []int64{30, 29, 28, 27} {
		loads.load = aLoad(available)
		if err := reporter.Report(false); err != nil {
			t.Fatal(err)
		}
	}
	if len(fleet.reports) != 1 {
		t.Fatalf("reports = %d while the load stayed in its step; want 1", len(fleet.reports))
	}
	loads.load = aLoad(20)
	if err := reporter.Report(false); err != nil {
		t.Fatal(err)
	}
	if len(fleet.reports) != 2 {
		t.Fatalf("reports = %d after memory moved 10 points; want 2", len(fleet.reports))
	}
	sent, ok := fleet.details[1].(map[string]any)["load"].(*machineload.Load)
	if !ok || sent.Memory.AvailableBytes != 20 {
		t.Fatalf("the second report carries %v; want the load as last read", fleet.details[1])
	}
}

func aUsage(input float64) *usage.Usage {
	cost := 0.0
	return &usage.Usage{
		Subscriptions: []usage.Subscription{{Harness: "claude-code", ReadAt: "2026-11-05T10:00:00.000Z", Windows: []usage.WindowReport{{WindowMinutes: 300, UsedPercent: 25.6, ResetsAt: "2026-12-23T04:26:40.000Z"}}}},
		Ships:         []usage.ShipUsage{{ShipID: scout, Models: []usage.ModelUsage{{Model: "claude-opus-5-5", Login: "subscription", Tokens: usage.Tokens{Input: input}, EstimatedCostUSD: &cost}}}},
	}
}

func TestTheDetailsCarryTheHarnessesUsageAsItWasRead(t *testing.T) {
	in := anInput()
	in.Usage = aUsage(10)
	want := map[string]any{
		"subscriptions": []any{map[string]any{"harness": "claude-code", "readAt": "2026-11-05T10:00:00.000Z", "windows": []any{map[string]any{"windowMinutes": 300.0, "usedPercent": 25.6, "resetsAt": "2026-12-23T04:26:40.000Z"}}}},
		"ships":         []any{map[string]any{"shipId": scout, "models": []any{map[string]any{"model": "claude-opus-5-5", "login": "subscription", "tokens": map[string]any{"input": 10.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0}, "estimatedCostUsd": 0.0}}}},
	}
	if got := detailsJSON(t, in)["usage"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("usage = %v; want %v", got, want)
	}
}

type aUsageReader struct {
	usage *usage.Usage
	err   error
}

func (r *aUsageReader) Read() (usage.Usage, error) {
	if r.err != nil {
		return usage.Usage{}, r.err
	}
	return *r.usage, nil
}

func TestTheReportGoesAgainOnceTheUsageChanged(t *testing.T) {
	reporter, fleet, _ := aReporter()
	usages := &aUsageReader{usage: aUsage(10)}
	reporter.Usage = usages
	for range 2 {
		if err := reporter.Report(false); err != nil {
			t.Fatal(err)
		}
	}
	usages.usage = aUsage(11)
	if err := reporter.Report(false); err != nil {
		t.Fatal(err)
	}
	if len(fleet.reports) != 2 {
		t.Fatalf("reports = %d; want one at start and one once the usage changed", len(fleet.reports))
	}
	if sent, ok := fleet.details[1].(map[string]any)["usage"].(*usage.Usage); !ok || sent.Ships[0].Models[0].Tokens.Input != 11 {
		t.Fatalf("the second report carries %v; want the usage as last read", fleet.details[1])
	}
}

func TestAReportWhoseUsageCouldNotBeReadIsNotSent(t *testing.T) {
	reporter, fleet, _ := aReporter()
	reporter.Usage = &aUsageReader{err: errors.New("the state cannot be read")}
	if err := reporter.Report(false); err == nil {
		t.Fatal("a report whose usage could not be read was not an error")
	}
	if len(fleet.reports) != 0 {
		t.Fatalf("reports = %d; want none", len(fleet.reports))
	}
}

func TestAHarnessWhosePluginIsMissingIsNotOfferedAndTheNoteSaysWhy(t *testing.T) {
	in := anInput()
	in.State.MissingPlugins = []string{"claude-code"}

	report := Of(in)

	if want := "0 of 6 running, claude-code not offered: its aeolus-fleet plugin is not installed (run aeolus-trierarch upgrade)"; report.Note != want {
		t.Fatalf("note = %q; want %q", report.Note, want)
	}
	details := asJSON(t, report)["details"].(map[string]any)
	if got := details["harnesses"]; !reflect.DeepEqual(got, []any{}) {
		t.Fatalf("harnesses = %v; want none", got)
	}
	want := []any{map[string]any{"harness": "claude-code", "reason": "its aeolus-fleet plugin is not installed (run aeolus-trierarch upgrade)"}}
	if got := details["notOffered"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("notOffered = %v; want %v", got, want)
	}
}

func TestAHarnessItsAdapterDoesNotOfferIsNotOfferedWithItsOwnReason(t *testing.T) {
	in := anInput()
	in.State.MissingPlugins = []string{"claude-code"}
	in.State.NotOffered = []reconciler.NotOfferedHarness{{Harness: "claude-code", Reason: "its Copilot CLI version is not detected yet"}}

	report := Of(in)

	if want := "0 of 6 running, claude-code not offered: its Copilot CLI version is not detected yet"; report.Note != want {
		t.Fatalf("note = %q; want %q", report.Note, want)
	}
	want := []any{map[string]any{"harness": "claude-code", "reason": "its Copilot CLI version is not detected yet"}}
	if got := detailsJSON(t, in)["notOffered"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("notOffered = %v; want %v", got, want)
	}
}

func TestADetailsOfAMachineOfferingEveryHarnessNameNoneNotOffered(t *testing.T) {
	if _, ok := detailsJSON(t, anInput())["notOffered"]; ok {
		t.Fatal("notOffered is named while every harness is offered")
	}
}

var stoppedAt = time.Date(2026, 10, 6, 8, 3, 0, 0, time.UTC)

// aStoppedInput is the input of a machine whose last start failed at stoppedAt, after the starts of the ships failed in a row.
func aStoppedInput(shipIDs ...string) Input {
	in := anInput()
	in.Now = stoppedAt
	for _, shipID := range shipIDs {
		in.State.FailedStarts, _ = failedstarts.Count(in.State.FailedStarts, failedstarts.Outcome{ShipID: shipID, Reason: "no activity within a minute of its start"}, stoppedAt, "{}")
	}
	return in
}

const stoppedReason = "the starts of 3 ships failed in a row; first: no activity within a minute of its start; it offers itself again at 2026-10-06T08:13:00.000Z"

func TestAMachineWhoseStartsKeepFailingOffersNoHarnessAndNoPlaceAndSaysWhy(t *testing.T) {
	in := aStoppedInput("shp_a", "shp_b", "shp_c")

	report := Of(in)
	details := asJSON(t, report)["details"].(map[string]any)

	if want := "0 of 6 running, not offered: " + stoppedReason; report.Note != want {
		t.Fatalf("note = %q, want %q", report.Note, want)
	}
	if got := details["harnesses"]; !reflect.DeepEqual(got, []any{}) {
		t.Fatalf("harnesses = %v", got)
	}
	if got := details["workspaces"]; !reflect.DeepEqual(got, map[string]any{"repositories": []any{}, "folders": []any{}}) {
		t.Fatalf("workspaces = %v", got)
	}
	if got, want := details["notOffered"], []any{map[string]any{"harness": "claude-code", "reason": stoppedReason}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("notOffered = %v, want %v", got, want)
	}
}

func TestAMachineWhoseStartsFailedForTwoShipsStillOffersItself(t *testing.T) {
	in := aStoppedInput("shp_a", "shp_b")

	details := detailsJSON(t, in)

	if _, isNamed := details["notOffered"]; isNamed || len(details["harnesses"].([]any)) != 1 || Of(in).Note != "0 of 6 running" {
		t.Fatalf("details = %v, note %q", details, Of(in).Note)
	}
}

func TestTheNoteSaysItIsNotOfferedAfterTheCrashedShipsAndBeforeTheFleetsKeyIsCutOff(t *testing.T) {
	in := aStoppedInput("shp_a", "shp_b", "shp_c")
	in.State.Entries = map[string]reconciler.Entry{scout: {ShipID: scout, State: "crashed"}}
	in.IsKeyCutOff = true

	want := "0 of 6 running, 1 crashed, not offered: " + stoppedReason + ", waiting for the fleet's key (KEY_UNAVAILABLE)"
	if got := Of(in).Note; got != want {
		t.Fatalf("note = %q, want %q", got, want)
	}
}

func TestAMachineOffersItselfAgainAsAProbeTenMinutesAfterItsLastFailedStartWithRoomForOneStart(t *testing.T) {
	in := aStoppedInput("shp_a", "shp_b", "shp_c")
	in.State.Entries = map[string]reconciler.Entry{scout: {ShipID: scout, State: "running"}}
	in.Now = stoppedAt.Add(10 * time.Minute)

	details := detailsJSON(t, in)

	if _, isNamed := details["notOffered"]; isNamed || len(details["harnesses"].([]any)) != 1 || Of(in).Note != "0 of 6 running" {
		t.Fatalf("details = %v, note %q", details, Of(in).Note)
	}
	if got, want := details["caps"], map[string]any{"ships": float64(2), "running": float64(4)}; !reflect.DeepEqual(got, want) {
		t.Fatalf("caps = %v, want %v", got, want)
	}
}

func TestAProbeWhoseStartHasNotDecidedYetOffersNoMoreRoom(t *testing.T) {
	in := aStoppedInput("shp_a", "shp_b", "shp_c")
	in.State.Entries = map[string]reconciler.Entry{scout: {ShipID: scout, State: "crewing", LaunchedAt: "2026-10-06T08:13:00.000Z"}}
	in.Now = stoppedAt.Add(10 * time.Minute)

	if got, want := detailsJSON(t, in)["caps"], map[string]any{"ships": float64(1), "running": float64(4)}; !reflect.DeepEqual(got, want) {
		t.Fatalf("caps = %v, want %v", got, want)
	}
}

func TestAMachineNotYetDueItsProbeOffersNoHarnessOneSecondEarly(t *testing.T) {
	in := aStoppedInput("shp_a", "shp_b", "shp_c")
	in.Now = stoppedAt.Add(10*time.Minute - time.Second)

	if got := detailsJSON(t, in)["harnesses"]; !reflect.DeepEqual(got, []any{}) {
		t.Fatalf("harnesses = %v", got)
	}
}

func TestAHarnessNamesTheMcpServersItOffers(t *testing.T) {
	in := anInput()
	in.McpServers = map[string][]string{"claude-code": {"company-graph"}}

	harnesses := detailsJSON(t, in)["harnesses"].([]any)

	if got := harnesses[0].(map[string]any)["mcpServers"]; !reflect.DeepEqual(got, []any{"company-graph"}) {
		t.Errorf("mcpServers = %v, want company-graph", got)
	}
}

func TestAHarnessOfferingNoMcpServerNamesNone(t *testing.T) {
	harnesses := detailsJSON(t, anInput())["harnesses"].([]any)

	if got, ok := harnesses[0].(map[string]any)["mcpServers"]; ok {
		t.Errorf("mcpServers = %v, want the field left out", got)
	}
}

func TestTheReportStatesTheKeySecretsAreSealedTo(t *testing.T) {
	in := anInput()
	in.SealingKey = "q1Xn7bOe0ySd0kT3k2r0cJ0sV1hR6nqv0ZpYd8m2kGQ="

	got := detailsJSON(t, in)["sealingKey"]

	want := map[string]any{"scheme": "nacl-sealed-box", "publicKey": "q1Xn7bOe0ySd0kT3k2r0cJ0sV1hR6nqv0ZpYd8m2kGQ="}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("sealingKey = %v, want %v", got, want)
	}
}

func TestATrierarchWithoutAKeyStatesNone(t *testing.T) {
	if got, ok := detailsJSON(t, anInput())["sealingKey"]; ok {
		t.Errorf("sealingKey = %v, want the field left out", got)
	}
}
