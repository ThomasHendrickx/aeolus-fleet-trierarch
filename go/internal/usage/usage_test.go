package usage

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// aHarness says the tokens it is given per ship and the windows it is given, failing while err is set; it counts its subscription reads.
type aHarness struct {
	tokens        map[string][]HourTokens
	windows       []Window
	err           error
	asked         []Ship
	subscriptions int
}

func (h *aHarness) TokensOf(ship Ship) ([]HourTokens, error) {
	h.asked = append(h.asked, ship)
	if h.err != nil {
		return nil, h.err
	}
	return h.tokens[ship.ShipID], nil
}

func (h *aHarness) Subscription() ([]Window, error) {
	h.subscriptions++
	if h.err != nil {
		return nil, h.err
	}
	return h.windows, nil
}

type aStore struct{ state reconciler.State }

func (s aStore) Load() (reconciler.State, error) { return s.state, nil }

// aClock is a time the test moves on.
type aClock struct{ now time.Time }

func (c *aClock) Now() time.Time { return c.now }

func aShipEntry(shipID string, harness string, folder string) reconciler.Entry {
	return reconciler.Entry{ShipID: shipID, Harness: harness, Folder: folder, Login: "subscription"}
}

func aReader(harnesses map[string]Harness, entries ...reconciler.Entry) (*Reader, *aClock, *[]string) {
	clock := &aClock{now: at("2026-11-05T10:00:00Z")}
	logged := &[]string{}
	state := reconciler.State{Entries: map[string]reconciler.Entry{}}
	for _, entry := range entries {
		state.Entries[entry.ShipID] = entry
	}
	reader := &Reader{
		Harnesses:  harnesses,
		Configured: []string{"claude-code", "codex"},
		Store:      aStore{state: state},
		Prices:     PricesOf(nil),
		Now:        clock.Now,
		Log:        func(line string) { *logged = append(*logged, line) },
	}
	return reader, clock, logged
}

func mustRead(t *testing.T, reader *Reader) Usage {
	t.Helper()
	read, err := reader.Read()
	if err != nil {
		t.Fatal(err)
	}
	return read
}

func TestEachCrewedShipsTokensAreReportedPerModelAndLoginOverTheHoursWithTheirEstimatedCost(t *testing.T) {
	claudeCode := &aHarness{tokens: map[string][]HourTokens{"shp_scout": {
		{Model: "claude-haiku-5-5", Login: "subscription", Hour: at("2026-11-05T09:00:00Z"), Tokens: Tokens{Input: 100_000, Output: 200_000}},
		{Model: "claude-opus-5-5", Login: "apiKey", Hour: at("2026-11-05T09:00:00Z"), Tokens: Tokens{Input: 1}},
		{Model: "claude-opus-5-5", Login: "subscription", Hour: at("2026-11-05T09:00:00Z"), Tokens: Tokens{Input: 1000, Output: 2000, CacheRead: 10_000, CacheWrite: 3000}},
		{Model: "claude-opus-5-5", Login: "subscription", Hour: at("2026-11-05T10:00:00Z"), Tokens: Tokens{Input: 500, Output: 1000}},
	}}}
	reader, _, _ := aReader(map[string]Harness{"claude-code": claudeCode}, aShipEntry("shp_scout", "claude-code", "/worktrees/aeolus-fleet/scout"))

	got := mustRead(t, reader).Ships

	cost := func(dollars float64) *float64 { return &dollars }
	want := []ShipUsage{{ShipID: "shp_scout", Models: []ModelUsage{
		{Model: "claude-haiku-5-5", Login: "subscription", Tokens: Tokens{Input: 100_000, Output: 200_000}, EstimatedCostUSD: cost(0.11)},
		{Model: "claude-opus-5-5", Login: "apiKey", Tokens: Tokens{Input: 1}, EstimatedCostUSD: cost(0)},
		{Model: "claude-opus-5-5", Login: "subscription", Tokens: Tokens{Input: 1500, Output: 3000, CacheRead: 10_000, CacheWrite: 3000}, EstimatedCostUSD: cost(0.09)},
	}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Ships = %s, want %s", mustJSON(t, got), mustJSON(t, want))
	}
}

func TestAShipIsAskedForItsTokensWithItsHarnessFolderAndTheLoginsOfItsSessions(t *testing.T) {
	codex := &aHarness{}
	entry := aShipEntry("shp_scout", "codex", "/worktrees/aeolus-fleet/scout")
	entry.Login, entry.EarlierLogins = "apiKey", []reconciler.EarlierLogin{{Login: "subscription", Until: "2026-11-05T09:00:00.000Z"}}
	withoutLogin := aShipEntry("shp_lookout", "codex", "/worktrees/aeolus-fleet/lookout")
	withoutLogin.Login = ""
	reader, _, _ := aReader(map[string]Harness{"codex": codex}, entry, withoutLogin)

	mustRead(t, reader)

	want := []Ship{
		{ShipID: "shp_lookout", Folder: "/worktrees/aeolus-fleet/lookout"},
		{ShipID: "shp_scout", Folder: "/worktrees/aeolus-fleet/scout", Logins: &Logins{Login: "apiKey", Earlier: entry.EarlierLogins}},
	}
	if !reflect.DeepEqual(codex.asked, want) {
		t.Fatalf("asked %+v, want %+v", codex.asked, want)
	}
}

func TestAShipWithNoFolderYetOrNoTokensIsNotReported(t *testing.T) {
	claudeCode := &aHarness{tokens: map[string][]HourTokens{}}
	reader, _, _ := aReader(map[string]Harness{"claude-code": claudeCode}, aShipEntry("shp_crewing", "claude-code", ""), aShipEntry("shp_quiet", "claude-code", "/worktrees/aeolus-fleet/quiet"), aShipEntry("shp_copilot", "copilot", "/worktrees/aeolus-fleet/copilot"))

	read := mustRead(t, reader)

	if len(read.Ships) != 0 {
		t.Fatalf("Ships = %+v, want none", read.Ships)
	}
	if len(claudeCode.asked) != 1 || claudeCode.asked[0].ShipID != "shp_quiet" {
		t.Fatalf("asked %+v, want shp_quiet alone", claudeCode.asked)
	}
}

func TestTheTokensAreReadAtStartThenOnlyOnceFiveMinutesPassed(t *testing.T) {
	claudeCode := &aHarness{tokens: map[string][]HourTokens{"shp_scout": {{Model: "claude-opus-5-5", Hour: at("2026-11-05T09:00:00Z"), Tokens: Tokens{Input: 1}}}}}
	reader, clock, _ := aReader(map[string]Harness{"claude-code": claudeCode}, aShipEntry("shp_scout", "claude-code", "/worktrees/aeolus-fleet/scout"))
	mustRead(t, reader)

	clock.now = clock.now.Add(TokensReadEvery - time.Second)
	mustRead(t, reader)
	if len(claudeCode.asked) != 1 {
		t.Fatalf("read %d times within 5 minutes, want once", len(claudeCode.asked))
	}
	clock.now = clock.now.Add(time.Second)
	mustRead(t, reader)
	if len(claudeCode.asked) != 2 {
		t.Fatalf("read %d times once 5 minutes passed, want twice", len(claudeCode.asked))
	}
}

func TestAShipWhoseTokensCouldNotBeReadKeepsWhatWasReadBefore(t *testing.T) {
	claudeCode := &aHarness{tokens: map[string][]HourTokens{"shp_scout": {{Model: "claude-opus-5-5", Hour: at("2026-11-05T09:00:00Z"), Tokens: Tokens{Input: 1}}}}}
	reader, clock, logged := aReader(map[string]Harness{"claude-code": claudeCode}, aShipEntry("shp_scout", "claude-code", "/worktrees/aeolus-fleet/scout"))
	before := mustRead(t, reader).Ships

	claudeCode.err = errors.New("permission denied")
	clock.now = clock.now.Add(TokensReadEvery)
	after := mustRead(t, reader).Ships

	if !reflect.DeepEqual(after, before) {
		t.Errorf("Ships = %+v, want what was read before %+v", after, before)
	}
	if want := "Could not read the usage of shp_scout: permission denied"; !reflect.DeepEqual(*logged, []string{want}) {
		t.Errorf("logged %q, want %q", *logged, want)
	}
}

func TestEachConfiguredHarnesssSubscriptionIsReportedWithWhenItWasRead(t *testing.T) {
	claudeCode := &aHarness{windows: []Window{{WindowMinutes: 300, UsedPercent: 25.6, ResetsAt: at("2026-12-23T04:26:40Z")}}}
	reader, _, _ := aReader(map[string]Harness{"claude-code": claudeCode, "codex": &aHarness{}})

	got := mustJSON(t, mustRead(t, reader))

	want := `{"subscriptions":[{"harness":"claude-code","readAt":"2026-11-05T10:00:00.000Z","windows":[{"windowMinutes":300,"usedPercent":25.6,"resetsAt":"2026-12-23T04:26:40.000Z"}]}],"ships":[]}`
	if got != want {
		t.Fatalf("usage = %s, want %s", got, want)
	}
}

func TestAShipsTokensAndTheirCostAreReportedAsTheReportSaysThem(t *testing.T) {
	claudeCode := &aHarness{tokens: map[string][]HourTokens{"shp_scout": {
		{Model: "claude-not-priced-1", Hour: at("2026-11-05T09:00:00Z"), Tokens: Tokens{Input: 10, Output: 20}},
	}}}
	reader, _, _ := aReader(map[string]Harness{"claude-code": claudeCode}, aShipEntry("shp_scout", "claude-code", "/worktrees/aeolus-fleet/scout"))

	got := mustJSON(t, mustRead(t, reader).Ships)

	if want := `[{"shipId":"shp_scout","models":[{"model":"claude-not-priced-1","tokens":{"input":10,"output":20,"cacheRead":0,"cacheWrite":0},"estimatedCostUsd":null}]}]`; got != want {
		t.Fatalf("Ships = %s, want %s", got, want)
	}
}

func TestASubscriptionIsReadAgainOnlyOnceThirtyMinutesPassedAndItsHarnesssShipsDidWorkSince(t *testing.T) {
	tokens := []HourTokens{{Model: "claude-opus-5-5", Hour: at("2026-11-05T09:00:00Z"), Tokens: Tokens{Input: 1}}}
	claudeCode := &aHarness{tokens: map[string][]HourTokens{"shp_scout": tokens}, windows: []Window{{WindowMinutes: 300}}}
	reader, clock, _ := aReader(map[string]Harness{"claude-code": claudeCode}, aShipEntry("shp_scout", "claude-code", "/worktrees/aeolus-fleet/scout"))
	mustRead(t, reader)

	clock.now = clock.now.Add(SubscriptionReadEvery)
	mustRead(t, reader)
	if claudeCode.subscriptions != 1 {
		t.Fatalf("read %d times after 30 minutes with no work, want once", claudeCode.subscriptions)
	}

	claudeCode.tokens["shp_scout"] = []HourTokens{{Model: "claude-opus-5-5", Hour: at("2026-11-05T09:00:00Z"), Tokens: Tokens{Input: 2}}}
	clock.now = clock.now.Add(TokensReadEvery)
	mustRead(t, reader)
	if claudeCode.subscriptions != 2 {
		t.Fatalf("read %d times after 30 minutes and work, want twice", claudeCode.subscriptions)
	}

	claudeCode.tokens["shp_scout"] = []HourTokens{{Model: "claude-opus-5-5", Hour: at("2026-11-05T09:00:00Z"), Tokens: Tokens{Input: 3}}}
	clock.now = clock.now.Add(SubscriptionReadEvery - time.Second)
	mustRead(t, reader)
	if claudeCode.subscriptions != 2 {
		t.Fatalf("read %d times within 30 minutes of the last read, want twice", claudeCode.subscriptions)
	}
}

func TestASubscriptionThatCouldNotBeReadKeepsTheWindowsReadBefore(t *testing.T) {
	claudeCode := &aHarness{tokens: map[string][]HourTokens{"shp_scout": {{Model: "claude-opus-5-5", Hour: at("2026-11-05T09:00:00Z"), Tokens: Tokens{Input: 1}}}}, windows: []Window{{WindowMinutes: 300, UsedPercent: 10}}}
	reader, clock, _ := aReader(map[string]Harness{"claude-code": claudeCode}, aShipEntry("shp_scout", "claude-code", "/worktrees/aeolus-fleet/scout"))
	before := mustRead(t, reader).Subscriptions

	claudeCode.windows = nil
	claudeCode.tokens["shp_scout"] = []HourTokens{{Model: "claude-opus-5-5", Hour: at("2026-11-05T09:00:00Z"), Tokens: Tokens{Input: 2}}}
	clock.now = clock.now.Add(SubscriptionReadEvery)
	after := mustRead(t, reader).Subscriptions

	if claudeCode.subscriptions != 2 {
		t.Fatalf("read %d times, want twice", claudeCode.subscriptions)
	}
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("Subscriptions = %+v, want what was read before %+v", after, before)
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	text, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}
