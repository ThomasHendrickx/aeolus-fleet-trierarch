package usage

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

const (
	trierarchShip = "shp_01m6jwb5xwnnezed207ddz58er"
	pluginShip    = "shp_01m6jyczpnpp5c0vxh54c966cy"
	scoutShip     = "shp_scout"
	mateShip      = "shp_mate"
)

// aSentStore holds the state and saves it whole, as the state file does.
type aSentStore struct{ state reconciler.State }

func (s *aSentStore) Load() (reconciler.State, error) { return s.state, nil }
func (s *aSentStore) Save(state reconciler.State) error {
	s.state = state
	return nil
}

// aUsageFleet writes down each usage message it is sent, refusing while refuse is set.
type aUsageFleet struct {
	sent   []sentUsage
	refuse error
}

type sentUsage struct{ pluginShipID, payload, key string }

func (f *aUsageFleet) SendUsage(pluginShipID string, payload string, idempotencyKey string) error {
	if f.refuse != nil {
		return f.refuse
	}
	f.sent = append(f.sent, sentUsage{pluginShipID, payload, idempotencyKey})
	return nil
}

// aReading is the readings the sender is given; a test sets them as the subscription reads would answer.
type aReading struct{ subscriptions []Subscription }

func (r *aReading) Read() (Usage, error) { return Usage{Subscriptions: r.subscriptions}, nil }

type aSender struct {
	*Sender
	harness *aHarness
	store   *aSentStore
	fleet   *aUsageFleet
	clock   *aClock
	reading *aReading
	logged  *[]string
	madeAt  map[string]time.Time
}

const folderMadeAt = "2026-10-06T06:00:00Z"

func aCrewedEntry(shipID string) reconciler.Entry {
	return reconciler.Entry{ShipID: shipID, Harness: "claude-code", State: "running", Folder: "/work/" + shipID, Login: ""}
}

func aSenderOf(entries ...reconciler.Entry) *aSender {
	state := reconciler.Empty()
	for _, entry := range entries {
		state.Entries[entry.ShipID] = entry
	}
	harness := &aHarness{tokens: map[string][]HourTokens{}}
	store := &aSentStore{state: state}
	fleet := &aUsageFleet{}
	clock := &aClock{now: at("2026-10-06T08:00:00Z")}
	reading := &aReading{}
	logged := &[]string{}
	madeAt := map[string]time.Time{}
	sender := &Sender{
		Harnesses:       map[string]Harness{"claude-code": harness},
		Reader:          reading,
		MadeAt:          func(folder string) (time.Time, error) { return orMade(madeAt, folder), nil },
		Store:           store,
		Fleet:           fleet,
		Prices:          PricesOf(nil),
		Now:             clock.Now,
		Log:             func(line string) { *logged = append(*logged, line) },
		TrierarchShipID: trierarchShip,
		PluginShipID:    pluginShip,
	}
	return &aSender{Sender: sender, harness: harness, store: store, fleet: fleet, clock: clock, reading: reading, logged: logged, madeAt: madeAt}
}

func orMade(madeAt map[string]time.Time, folder string) time.Time {
	if made, ok := madeAt[folder]; ok {
		return made
	}
	return at(folderMadeAt)
}

var opus = HourTokens{Model: "claude-opus-5-5", Hour: at("2026-10-06T07:00:00Z"), Tokens: Tokens{Input: 1200, Output: 45_000, CacheRead: 9_800_000, CacheWrite: 410_000}}

// opusCost is opus at Claude Opus 5.5's list prices (4, 20, 0.2 and 8 dollars per million), kind by kind.
const opusCost = `{"input":0.0048,"output":0.9,"cacheRead":1.96,"cacheWrite":3.28}`

func mustSend(t *testing.T, sender *aSender) {
	t.Helper()
	if err := sender.Send(); err != nil {
		t.Fatal(err)
	}
}

// message is a usage message as common's schema shapes it, for the parts a test looks at.
type message struct {
	Hours []struct {
		Hour  string `json:"hour"`
		Ships []struct {
			ShipID       string  `json:"shipId"`
			Harness      string  `json:"harness"`
			FolderMadeAt string  `json:"folderMadeAt"`
			Login        *string `json:"login"`
			Models       []struct {
				Model            string          `json:"model"`
				Tokens           Tokens          `json:"tokens"`
				EstimatedCostUSD json.RawMessage `json:"estimatedCostUsd"`
			} `json:"models"`
		} `json:"ships"`
	} `json:"hours"`
	Subscriptions []Subscription `json:"subscriptions"`
	ReadAt        string         `json:"readAt"`
}

func messagesOf(t *testing.T, sent []sentUsage) []message {
	t.Helper()
	var messages []message
	for _, each := range sent {
		var parsed message
		if err := json.Unmarshal([]byte(each.payload), &parsed); err != nil {
			t.Fatalf("a usage message is no message: %v: %s", err, each.payload)
		}
		messages = append(messages, parsed)
	}
	return messages
}

func hoursOf(m message) []string {
	hours := []string{}
	for _, hour := range m.Hours {
		hours = append(hours, hour.Hour)
	}
	return hours
}

func TestTheUsageSentHoldsEachShipsTokensPerUTCHourWithItsFolderHarnessLoginAndCostPerKindAndTheSubscriptionReadings(t *testing.T) {
	sender := aSenderOf(aCrewedEntry(scoutShip))
	sender.harness.tokens[scoutShip] = []HourTokens{opus}
	sender.reading.subscriptions = []Subscription{{Harness: "claude-code", ReadAt: "2026-10-06T08:00:00.000Z", Windows: []WindowReport{{WindowMinutes: 300, UsedPercent: 3, ResetsAt: "2026-10-06T12:00:00.000Z"}}}}

	mustSend(t, sender)

	if len(sender.fleet.sent) != 1 {
		t.Fatalf("sent %d messages, want 1", len(sender.fleet.sent))
	}
	sent := sender.fleet.sent[0]
	if sent.pluginShipID != pluginShip || sent.key != "usage:"+trierarchShip+":2026-10-06T08:00:00.000Z" {
		t.Errorf("sent to %s under %s", sent.pluginShipID, sent.key)
	}
	want := `{"hours":[{"hour":"2026-10-06T07:00:00.000Z","ships":[{"shipId":"` + scoutShip + `","harness":"claude-code","folderMadeAt":"2026-10-06T06:00:00.000Z","login":null,"models":[{"model":"claude-opus-5-5","tokens":{"input":1200,"output":45000,"cacheRead":9800000,"cacheWrite":410000},"estimatedCostUsd":` + opusCost + `}]}]}],` +
		`"subscriptions":[{"harness":"claude-code","readAt":"2026-10-06T08:00:00.000Z","windows":[{"windowMinutes":300,"usedPercent":3,"resetsAt":"2026-10-06T12:00:00.000Z"}]}],"readAt":"2026-10-06T08:00:00.000Z"}`
	if sent.payload != want {
		t.Errorf("payload = %s\nwant %s", sent.payload, want)
	}
}

func TestTheUsageSentNamesTheLoginAShipRanOnAndHasNoCostForAModelNotPriced(t *testing.T) {
	entry := aCrewedEntry(scoutShip)
	entry.Login = "apiKey"
	sender := aSenderOf(entry)
	sender.harness.tokens[scoutShip] = []HourTokens{{Model: "claude-mystery-1", Login: "apiKey", Hour: at("2026-10-06T07:00:00Z"), Tokens: Tokens{Input: 10, Output: 5}}}

	mustSend(t, sender)

	ship := messagesOf(t, sender.fleet.sent)[0].Hours[0].Ships[0]
	model := ship.Models[0]
	if ship.Login == nil || *ship.Login != "apiKey" || string(model.EstimatedCostUSD) != "null" {
		t.Errorf("login %v, cost %s, want apiKey and null", ship.Login, model.EstimatedCostUSD)
	}
	if got := sender.harness.asked[0].Logins; got == nil || got.Login != "apiKey" {
		t.Errorf("the harness was asked with logins %v, want the entry's", got)
	}
}

func TestTheUsageIsSentAgainOnlyOnceTheHourTurns(t *testing.T) {
	sender := aSenderOf(aCrewedEntry(scoutShip))
	sender.harness.tokens[scoutShip] = []HourTokens{opus}
	mustSend(t, sender)
	sender.harness.tokens[scoutShip] = []HourTokens{{Model: opus.Model, Hour: at("2026-10-06T08:00:00Z"), Tokens: opus.Tokens}, opus}

	sender.clock.now = sender.clock.now.Add(59 * time.Minute)
	mustSend(t, sender)
	if len(sender.fleet.sent) != 1 {
		t.Fatalf("sent %d messages within the hour, want 1", len(sender.fleet.sent))
	}

	sender.clock.now = sender.clock.now.Add(time.Minute)
	mustSend(t, sender)
	if len(sender.fleet.sent) != 2 {
		t.Errorf("sent %d messages once the hour turned, want 2", len(sender.fleet.sent))
	}
}

func TestOnlyTheHoursWhoseTotalsChangedSinceTheLastSendThatReturnedOKAreSentEachWhole(t *testing.T) {
	sender := aSenderOf(aCrewedEntry(scoutShip), aCrewedEntry(mateShip))
	sender.harness.tokens[scoutShip] = []HourTokens{opus}
	sender.harness.tokens[mateShip] = []HourTokens{opus}
	mustSend(t, sender)
	// A late transcript entry changes scout's 07:00 hour; mate's stays as sent.
	late := opus
	late.Tokens.Output = 46_000
	sender.harness.tokens[scoutShip] = []HourTokens{late}

	sender.clock.now = sender.clock.now.Add(time.Hour)
	mustSend(t, sender)

	resent := messagesOf(t, sender.fleet.sent)[1]
	ships := []string{}
	for _, ship := range resent.Hours[0].Ships {
		ships = append(ships, ship.ShipID)
	}
	slices.Sort(ships)
	if !reflect.DeepEqual(hoursOf(resent), []string{"2026-10-06T07:00:00.000Z"}) || !reflect.DeepEqual(ships, []string{mateShip, scoutShip}) {
		t.Errorf("resent hours %v of ships %v, want the 07:00 hour whole across both ships", hoursOf(resent), ships)
	}
}

func TestNothingIsSentWhenNoHourChangedAndNoSubscriptionWasReadSinceTheLastSend(t *testing.T) {
	sender := aSenderOf(aCrewedEntry(scoutShip))
	sender.harness.tokens[scoutShip] = []HourTokens{opus}
	mustSend(t, sender)

	sender.clock.now = sender.clock.now.Add(time.Hour)
	mustSend(t, sender)

	if len(sender.fleet.sent) != 1 {
		t.Errorf("sent %d messages, want 1", len(sender.fleet.sent))
	}
}

func TestASendTheFleetRefusesMarksNothingSentSoTheNextCarriesThoseHoursToo(t *testing.T) {
	sender := aSenderOf(aCrewedEntry(scoutShip))
	sender.harness.tokens[scoutShip] = []HourTokens{opus}
	sender.fleet.refuse = errors.New("the daily message limit")
	mustSend(t, sender)
	sender.fleet.refuse = nil

	sender.clock.now = sender.clock.now.Add(time.Hour)
	mustSend(t, sender)

	sent := messagesOf(t, sender.fleet.sent)
	if len(sent) != 1 || !reflect.DeepEqual(hoursOf(sent[0]), []string{"2026-10-06T07:00:00.000Z"}) {
		t.Errorf("sent %d messages, want the refused hour carried by one", len(sent))
	}
	if !slices.ContainsFunc(*sender.logged, func(line string) bool { return strings.Contains(line, "Could not send the usage") }) {
		t.Errorf("logged %v, want that the usage could not be sent", *sender.logged)
	}
}

func TestEverySubscriptionReadingSinceTheLastSendThatReturnedOKIsSentEachOnce(t *testing.T) {
	sender := aSenderOf(aCrewedEntry(scoutShip))
	sender.harness.tokens[scoutShip] = []HourTokens{opus}
	five := func(readAt string, percent float64) []Subscription {
		return []Subscription{{Harness: "claude-code", ReadAt: readAt, Windows: []WindowReport{{WindowMinutes: 300, UsedPercent: percent, ResetsAt: "2026-10-06T12:00:00.000Z"}}}}
	}
	sender.reading.subscriptions = five("2026-10-06T08:00:00.000Z", 3)
	sender.fleet.refuse = errors.New("unreachable")
	mustSend(t, sender)
	sender.fleet.refuse = nil
	// 31 minutes on, the subscription is read again within the hour.
	sender.clock.now = sender.clock.now.Add(31 * time.Minute)
	sender.reading.subscriptions = five("2026-10-06T08:31:00.000Z", 9)
	mustSend(t, sender)
	sender.clock.now = sender.clock.now.Add(29 * time.Minute)
	mustSend(t, sender)
	sender.clock.now = sender.clock.now.Add(time.Hour)
	mustSend(t, sender)

	var read []string
	for _, each := range messagesOf(t, sender.fleet.sent) {
		for _, subscription := range each.Subscriptions {
			read = append(read, fmt.Sprintf("%s %v", subscription.ReadAt, subscription.Windows[0].UsedPercent))
		}
	}
	if want := []string{"2026-10-06T08:00:00.000Z 3", "2026-10-06T08:31:00.000Z 9"}; !reflect.DeepEqual(read, want) || len(sender.fleet.sent) != 1 {
		t.Errorf("sent readings %v in %d messages, want %v in 1", read, len(sender.fleet.sent), want)
	}
}

func TestAShipsFreshFolderIsKeptApartItsHoursAreSentThoughTheOldFoldersSameHoursWere(t *testing.T) {
	entry := aCrewedEntry(scoutShip)
	sender := aSenderOf(entry)
	sender.harness.tokens[scoutShip] = []HourTokens{opus}
	mustSend(t, sender)
	sender.madeAt[entry.Folder] = at("2026-10-06T07:30:00Z")

	sender.clock.now = sender.clock.now.Add(time.Hour)
	mustSend(t, sender)

	if got := messagesOf(t, sender.fleet.sent)[1].Hours[0].Ships[0].FolderMadeAt; got != "2026-10-06T07:30:00.000Z" {
		t.Errorf("folderMadeAt = %s, want the fresh folder's", got)
	}
}

func TestASendOver64KBGoesAsSeveralMessagesOfWholeHoursEachUnder64KB(t *testing.T) {
	sender := aSenderOf(aCrewedEntry(scoutShip))
	var hours []HourTokens
	for i := range 400 {
		each := opus
		each.Hour = at("2026-09-20T00:00:00Z").Add(time.Duration(i) * time.Hour)
		hours = append(hours, each)
	}
	sender.harness.tokens[scoutShip] = hours

	mustSend(t, sender)

	keys := map[string]bool{}
	var sentHours []string
	for _, each := range sender.fleet.sent {
		keys[each.key] = true
		if len(each.payload) > 64*1024 {
			t.Errorf("a message holds %d bytes, want at most 65536", len(each.payload))
		}
	}
	for _, each := range messagesOf(t, sender.fleet.sent) {
		sentHours = append(sentHours, hoursOf(each)...)
	}
	if len(sender.fleet.sent) < 2 || len(keys) != len(sender.fleet.sent) || len(sentHours) != 400 || !slices.IsSorted(sentHours) {
		t.Errorf("%d messages under %d keys with %d hours, want several under their own keys with the 400 hours in order", len(sender.fleet.sent), len(keys), len(sentHours))
	}
	if second := sender.fleet.sent[1].key; second != "usage:"+trierarchShip+":2026-10-06T08:00:00.000Z:2" {
		t.Errorf("the second message's key = %s, want :2 after the first's", second)
	}
}

func TestNothingIsSentOnAMachineThatDoesNotKnowThePluginsShipOrItsOwn(t *testing.T) {
	for name, forget := range map[string]func(*Sender){
		"the plugin's ship": func(s *Sender) { s.PluginShipID = "" },
		"its own ship":      func(s *Sender) { s.TrierarchShipID = "" },
	} {
		t.Run(name, func(t *testing.T) {
			sender := aSenderOf(aCrewedEntry(scoutShip))
			sender.harness.tokens[scoutShip] = []HourTokens{opus}
			forget(sender.Sender)

			mustSend(t, sender)
			released := sender.SendReleased(aCrewedEntry(scoutShip))

			if len(sender.fleet.sent) != 0 || released != nil {
				t.Errorf("sent %d messages (release answered %v), want none", len(sender.fleet.sent), released)
			}
		})
	}
}

func TestTheHoursSentAreMarkedInTheShipsEntryByTheFoldersMadeTimeAndTheHour(t *testing.T) {
	sender := aSenderOf(aCrewedEntry(scoutShip))
	sender.harness.tokens[scoutShip] = []HourTokens{opus}

	mustSend(t, sender)

	key := "2026-10-06T06:00:00.000Z 2026-10-06T07:00:00.000Z"
	marked := sender.store.state.Entries[scoutShip].SentUsage
	if len(marked) != 1 || !strings.HasPrefix(marked[key], `[{"shipId":"`+scoutShip+`"`) {
		t.Errorf("sentUsage = %v, want the hour's ships as sent under %q", marked, key)
	}
}

func TestAShipWithNoFolderYetSendsNothing(t *testing.T) {
	entry := aCrewedEntry(scoutShip)
	entry.Folder = ""
	sender := aSenderOf(entry)

	mustSend(t, sender)

	if len(sender.fleet.sent) != 0 || len(sender.harness.asked) != 0 {
		t.Errorf("sent %d messages after %d reads, want none", len(sender.fleet.sent), len(sender.harness.asked))
	}
}

func TestAReleasedShipsLastUsageIsSentUnderAKeyNamingTheShipWithEveryHourNotSentYet(t *testing.T) {
	entry := aCrewedEntry(scoutShip)
	sender := aSenderOf(entry)
	sender.harness.tokens[scoutShip] = []HourTokens{opus}

	if err := sender.SendReleased(entry); err != nil {
		t.Fatal(err)
	}

	if len(sender.fleet.sent) != 1 || sender.fleet.sent[0].key != "usage:"+trierarchShip+":2026-10-06T08:00:00.000Z:"+scoutShip || sender.fleet.sent[0].pluginShipID != pluginShip {
		t.Fatalf("sent %v, want one message under a key naming the ship", sender.fleet.sent)
	}
	released := messagesOf(t, sender.fleet.sent)[0]
	if !reflect.DeepEqual(hoursOf(released), []string{"2026-10-06T07:00:00.000Z"}) || len(released.Subscriptions) != 0 {
		t.Errorf("sent hours %v with %d subscriptions, want the hour and no subscription", hoursOf(released), len(released.Subscriptions))
	}
}

func TestAReleasedShipsHoursAlreadySentAreNotSentAgain(t *testing.T) {
	entry := aCrewedEntry(scoutShip)
	sender := aSenderOf(entry)
	sender.harness.tokens[scoutShip] = []HourTokens{opus}
	mustSend(t, sender)
	sent := sender.store.state.Entries[scoutShip]

	if err := sender.SendReleased(sent); err != nil {
		t.Fatal(err)
	}

	if len(sender.fleet.sent) != 1 {
		t.Errorf("sent %d messages, want only the hourly one", len(sender.fleet.sent))
	}
}

func TestAReleasedShipsLastUsageTheFleetDoesNotTakeFailsTheReleaseSoItsFolderStays(t *testing.T) {
	entry := aCrewedEntry(scoutShip)
	sender := aSenderOf(entry)
	sender.harness.tokens[scoutShip] = []HourTokens{opus}
	sender.fleet.refuse = errors.New("unreachable")

	err := sender.SendReleased(entry)

	if !errors.Is(err, sender.fleet.refuse) {
		t.Errorf("SendReleased = %v, want the fleet's refusal", err)
	}
}

func TestAReleasedShipsTranscriptsThatCannotBeReadAreLoggedAndTheReleaseGoesOn(t *testing.T) {
	entry := aCrewedEntry(scoutShip)
	sender := aSenderOf(entry)
	sender.harness.err = errors.New("permission denied")

	err := sender.SendReleased(entry)

	if err != nil || len(sender.fleet.sent) != 0 || !slices.ContainsFunc(*sender.logged, func(line string) bool {
		return strings.Contains(line, "Could not read the last usage of "+scoutShip) && strings.Contains(line, "permission denied")
	}) {
		t.Errorf("SendReleased = %v after %d sends, logged %v, want it logged and no failure", err, len(sender.fleet.sent), *sender.logged)
	}
}
