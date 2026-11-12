package usage

import (
	"bytes"
	"cmp"
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// messageMaxBytes is the most one usage message holds (the usage design): a send over it goes as several messages of whole hours.
const messageMaxBytes = 64 * 1024

// microDollars is how finely the cost of each kind of tokens is told: to the millionth of a dollar.
const microDollars = 1_000_000

// UsageFleet is the fleet as the usage goes out: a message to the trierarch plugin's ship.
type UsageFleet interface {
	SendUsage(pluginShipID string, payload string, idempotencyKey string) error
}

// ReadingStore is the saved state, which says what each ship's hours were last sent as.
type ReadingStore interface {
	Load() (reconciler.State, error)
	Save(state reconciler.State) error
}

// SubscriptionReader reads the harnesses' usage, whose subscription readings go with the hourly send.
type SubscriptionReader interface {
	Read() (Usage, error)
}

// Sender sends the trierarch plugin's ship the usage (the usage design, "What the trierarch sends, and when"). At the first pass after the hour turns, and the first after it starts, Send reads each crewed ship's tokens per UTC hour and sends every hour whose totals changed since its last send that returned OK, each hour whole across its ships, and every subscription reading since. Over 64 KB it goes as several messages of whole hours. Only a send that returned OK marks its hours sent, in the ship's entry, so a send the fleet refuses is carried by the next. A machine that does not know the plugin's ship, or its own, sends nothing.
type Sender struct {
	Harnesses map[string]Harness
	Reader    SubscriptionReader
	// MadeAt is when a ship's folder was made: it keeps a fresh folder's hours apart from an old folder's of the same name.
	MadeAt func(folder string) (time.Time, error)
	Store  ReadingStore
	Fleet  UsageFleet
	Prices map[string]config.Price
	Now    func() time.Time
	Log    func(line string)
	// TrierarchShipID is the trierarch's own ship; a crew file written before it was kept names none.
	TrierarchShipID string
	PluginShipID    string

	hasTried bool
	// triedHour is the hour (since the epoch) the last send was tried in.
	triedHour int64
	// pending are the subscription readings not sent yet, by harness and when, gathered each pass: a harness is read again within an hour.
	pending map[string]Subscription
	sent    map[string]bool
}

// shipHour is one ship's usage of one UTC hour as it goes into the message, and its key in the entry's SentUsage.
type shipHour struct {
	shipID string
	hour   string
	key    string
	ships  []shipInHour
	// text is the ships as the entry keeps them once sent.
	text string
}

type shipInHour struct {
	ShipID       string        `json:"shipId"`
	Harness      string        `json:"harness"`
	FolderMadeAt string        `json:"folderMadeAt"`
	Login        *string       `json:"login"`
	Models       []modelInSend `json:"models"`
}

type modelInSend struct {
	Model            string  `json:"model"`
	Tokens           Tokens  `json:"tokens"`
	EstimatedCostUSD *Tokens `json:"estimatedCostUsd"`
}

type hourInSend struct {
	Hour  string       `json:"hour"`
	Ships []shipInHour `json:"ships"`
}

type usageMessage struct {
	Hours         []hourInSend   `json:"hours"`
	Subscriptions []Subscription `json:"subscriptions"`
	ReadAt        string         `json:"readAt"`
}

// textOf is the value as JSON, the way JavaScript's JSON.stringify writes it: no HTML escaping, so a state today's trierarch wrote compares equal.
func textOf(value any) (string, error) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return strings.TrimSuffix(out.String(), "\n"), nil
}

// costPerKind is what each kind of the tokens costs at the model's price, to the millionth of a dollar; none for a model the prices do not name.
func costPerKind(tokens Tokens, prices map[string]config.Price, model string) *Tokens {
	price, ok := prices[model]
	if !ok {
		return nil
	}
	// As JavaScript's Math.round, which today's trierarch rounds with: half up.
	cost := func(count float64, perMillion float64) float64 {
		return math.Floor(count*perMillion+0.5) / microDollars
	}
	return &Tokens{Input: cost(tokens.Input, price.Input), Output: cost(tokens.Output, price.Output), CacheRead: cost(tokens.CacheRead, price.CacheRead), CacheWrite: cost(tokens.CacheWrite, price.CacheWrite)}
}

// shipHoursOf is a crewed ship's usage per UTC hour, as it goes into the message; none before its folder is made. A read that fails is an error.
func (s *Sender) shipHoursOf(entry reconciler.Entry) ([]shipHour, error) {
	if entry.Folder == "" {
		return nil, nil
	}
	reader, ok := s.Harnesses[entry.Harness]
	if !ok {
		return nil, nil
	}
	ship := Ship{ShipID: entry.ShipID, Folder: entry.Folder, ShipFolder: entry.ShipFolder}
	if entry.Login != "" {
		ship.Logins = &Logins{Login: entry.Login, Earlier: entry.EarlierLogins}
	}
	made, err := s.MadeAt(entry.Folder)
	if err != nil {
		return nil, err
	}
	used, err := reader.TokensOf(ship)
	if err != nil {
		return nil, err
	}
	folderMadeAt := isoOf(made)
	var hours []string
	byHour := map[string][]HourTokens{}
	for _, each := range used {
		hour := isoOf(each.Hour)
		if _, seen := byHour[hour]; !seen {
			hours = append(hours, hour)
		}
		byHour[hour] = append(byHour[hour], each)
	}
	var shipHours []shipHour
	for _, hour := range hours {
		var logins []string
		byLogin := map[string][]HourTokens{}
		for _, each := range byHour[hour] {
			if _, seen := byLogin[each.Login]; !seen {
				logins = append(logins, each.Login)
			}
			byLogin[each.Login] = append(byLogin[each.Login], each)
		}
		var ships []shipInHour
		for _, login := range logins {
			inHour := shipInHour{ShipID: entry.ShipID, Harness: entry.Harness, FolderMadeAt: folderMadeAt, Models: []modelInSend{}}
			if login != "" {
				inHour.Login = &login
			}
			for _, each := range byLogin[login] {
				inHour.Models = append(inHour.Models, modelInSend{Model: each.Model, Tokens: each.Tokens, EstimatedCostUSD: costPerKind(each.Tokens, s.Prices, each.Model)})
			}
			ships = append(ships, inHour)
		}
		text, err := textOf(ships)
		if err != nil {
			return nil, err
		}
		shipHours = append(shipHours, shipHour{shipID: entry.ShipID, hour: hour, key: folderMadeAt + " " + hour, ships: ships, text: text})
	}
	return shipHours, nil
}

// changedOf are the ship hours whose totals differ from what the entry says was sent of them.
func changedOf(entry reconciler.Entry, shipHours []shipHour) []shipHour {
	return slices.DeleteFunc(slices.Clone(shipHours), func(each shipHour) bool {
		return entry.SentUsage[each.key] == each.text
	})
}

// hoursOfShipHours are the hours of the ship hours, each whole across its ships, oldest first.
func hoursOfShipHours(shipHours []shipHour) []hourInSend {
	var hours []hourInSend
	for _, hour := range slices.Sorted(maps.Keys(groupByHour(shipHours))) {
		var ships []shipInHour
		for _, each := range shipHours {
			if each.hour == hour {
				ships = append(ships, each.ships...)
			}
		}
		hours = append(hours, hourInSend{Hour: hour, Ships: ships})
	}
	return hours
}

func groupByHour(shipHours []shipHour) map[string]bool {
	hours := map[string]bool{}
	for _, each := range shipHours {
		hours[each.hour] = true
	}
	return hours
}

// pack puts whole hours into messages under the most a message holds, oldest hour first; the subscription readings go with the first.
func pack(hours []hourInSend, subscriptions []Subscription, readAt string) ([]usageMessage, error) {
	messages := []usageMessage{{Hours: []hourInSend{}, Subscriptions: subscriptions, ReadAt: readAt}}
	for _, hour := range hours {
		last := messages[len(messages)-1]
		grown := usageMessage{Hours: append(slices.Clone(last.Hours), hour), Subscriptions: last.Subscriptions, ReadAt: readAt}
		text, err := textOf(grown)
		if err != nil {
			return nil, err
		}
		if len(last.Hours) > 0 && len(text) > messageMaxBytes {
			messages = append(messages, usageMessage{Hours: []hourInSend{hour}, Subscriptions: []Subscription{}, ReadAt: readAt})
		} else {
			messages[len(messages)-1] = grown
		}
	}
	return messages, nil
}

func (s *Sender) knowsShips() bool {
	return s.PluginShipID != "" && s.TrierarchShipID != ""
}

// markSent marks the ship hours sent in their entries, as the state holds them now.
func (s *Sender) markSent(sent []shipHour) error {
	state, err := s.Store.Load()
	if err != nil {
		return err
	}
	for _, each := range sent {
		entry, ok := state.Entries[each.shipID]
		if !ok {
			continue
		}
		marked := maps.Clone(entry.SentUsage)
		if marked == nil {
			marked = map[string]string{}
		}
		marked[each.key] = each.text
		entry.SentUsage = marked
		state.Entries[each.shipID] = entry
	}
	return s.Store.Save(state)
}

// gather takes the subscription readings the read answers that were not sent yet.
func (s *Sender) gather(read []Subscription) {
	if s.pending == nil {
		s.pending, s.sent = map[string]Subscription{}, map[string]bool{}
	}
	current := map[string]bool{}
	for _, reading := range read {
		current[reading.Harness+" "+reading.ReadAt] = true
	}
	// Only the readings the read still answers can come again: the others need not be remembered as sent.
	for key := range s.sent {
		if !current[key] {
			delete(s.sent, key)
		}
	}
	for _, reading := range read {
		if key := reading.Harness + " " + reading.ReadAt; !s.sent[key] {
			s.pending[key] = reading
		}
	}
}

// Send sends the usage that changed once the hour turned since the last send. A send the fleet refuses is logged, not failed: the next carries it. It fails only when the state or the subscription readings cannot be read.
func (s *Sender) Send() error {
	if !s.knowsShips() {
		return nil
	}
	read, err := s.Reader.Read()
	if err != nil {
		return err
	}
	s.gather(read.Subscriptions)
	now := s.Now()
	hourNow := now.UnixMilli() / hourMs
	if s.hasTried && s.triedHour == hourNow {
		return nil
	}
	s.hasTried, s.triedHour = true, hourNow
	state, err := s.Store.Load()
	if err != nil {
		return err
	}
	var all, changed []shipHour
	for _, id := range slices.Sorted(maps.Keys(state.Entries)) {
		entry := state.Entries[id]
		shipHours, err := s.shipHoursOf(entry)
		if err != nil {
			s.Log(fmt.Sprintf("Could not read the usage of %s to send: %v", entry.ShipID, err))
			continue
		}
		all = append(all, shipHours...)
		changed = append(changed, changedOf(entry, shipHours)...)
	}
	readings := slices.SortedFunc(maps.Values(s.pending), func(a, b Subscription) int {
		return cmp.Or(strings.Compare(a.ReadAt, b.ReadAt), strings.Compare(a.Harness, b.Harness))
	})
	if len(changed) == 0 && len(readings) == 0 {
		return nil
	}
	// An hour changed for one ship is sent whole across the ships.
	changedHours := groupByHour(changed)
	whole := slices.DeleteFunc(slices.Clone(all), func(each shipHour) bool { return !changedHours[each.hour] })
	readAt := isoOf(now)
	messages, err := pack(hoursOfShipHours(whole), nonNil(readings), readAt)
	if err != nil {
		return err
	}
	for index, each := range messages {
		key := fmt.Sprintf("usage:%s:%s", s.TrierarchShipID, readAt)
		if index > 0 {
			key += fmt.Sprintf(":%d", index+1)
		}
		text, err := textOf(each)
		if err != nil {
			return err
		}
		if err := s.Fleet.SendUsage(s.PluginShipID, text, key); err != nil {
			s.Log(fmt.Sprintf("Could not send the usage to the trierarch plugin's ship: %v; the next send carries it", err))
			return nil
		}
		sentHours := map[string]bool{}
		for _, hour := range each.Hours {
			sentHours[hour.Hour] = true
		}
		if err := s.markSent(slices.DeleteFunc(slices.Clone(whole), func(each shipHour) bool { return !sentHours[each.hour] })); err != nil {
			return err
		}
		for _, reading := range each.Subscriptions {
			key := reading.Harness + " " + reading.ReadAt
			s.sent[key] = true
			delete(s.pending, key)
		}
	}
	return nil
}

func nonNil(readings []Subscription) []Subscription {
	if readings == nil {
		return []Subscription{}
	}
	return readings
}

// SendReleased sends a released ship's last usage, read once more, before its folder goes: every hour of it whose totals changed since its last send that returned OK (the usage design, U9). It fails when the fleet does not take it, so the folder stays and the release tries again on the next pass. Transcripts that cannot be read hold nothing it could send: logged, and the release goes on. Nothing to send, or a machine that does not know the plugin's ship or its own, sends nothing. The key names the ship, as an hourly send may share the moment.
func (s *Sender) SendReleased(entry reconciler.Entry) error {
	if !s.knowsShips() {
		return nil
	}
	read, err := s.shipHoursOf(entry)
	if err != nil {
		s.Log(fmt.Sprintf("Could not read the last usage of %s: %v; it is released without it", entry.ShipID, err))
		return nil
	}
	changed := changedOf(entry, read)
	if len(changed) == 0 {
		return nil
	}
	readAt := isoOf(s.Now())
	messages, err := pack(hoursOfShipHours(changed), []Subscription{}, readAt)
	if err != nil {
		return err
	}
	for index, each := range messages {
		key := fmt.Sprintf("usage:%s:%s:%s", s.TrierarchShipID, readAt, entry.ShipID)
		if index > 0 {
			key += fmt.Sprintf(":%d", index+1)
		}
		text, err := textOf(each)
		if err != nil {
			return err
		}
		if err := s.Fleet.SendUsage(s.PluginShipID, text, key); err != nil {
			return fmt.Errorf("send the last usage of %s: %w", entry.ShipID, err)
		}
	}
	return nil
}
