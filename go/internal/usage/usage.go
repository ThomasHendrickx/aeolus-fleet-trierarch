// Package usage is the harnesses' usage as the trierarch reports it (#353,
// docs/trierarch.md, "What a trierarch reports"): each crewed ship's tokens
// per model and login, with their estimated cost, from its harness's
// transcripts, and each harness's subscription windows. Each part is read on
// its own interval, the last read between, as today's trierarch reads them
// (core/read-usage.ts).
package usage

import (
	"fmt"
	"maps"
	"slices"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// TokensReadEvery is how often the ships' tokens are read from their transcripts: a report on them at most this often.
const TokensReadEvery = 5 * time.Minute

// SubscriptionReadEvery is how often a harness's subscription is read at most: Claude Code's costs a short turn of its own.
const SubscriptionReadEvery = 30 * time.Minute

// Window is one window of a harness's subscription: how long it is, how much of it is used, and when it starts again.
type Window struct {
	WindowMinutes float64
	UsedPercent   float64
	ResetsAt      time.Time
}

// Ship is a crewed ship as its harness is asked for its tokens: its folder, and the logins of its sessions; none for an entry saved before its login was kept, whose tokens count to no login (K8).
type Ship struct {
	ShipID string
	Folder string
	// ShipFolder is the ship's own folder, which holds its home in a container; none for a ship crewed before the ship folders.
	ShipFolder string
	Logins     *Logins
}

// Harness is what one harness says of its usage.
type Harness interface {
	// TokensOf are the tokens the ship's sessions used since its folder was made, per model, login and UTC hour.
	TokensOf(ship Ship) ([]HourTokens, error)
	// Subscription is how much of the harness's subscription is used now, per window; none when the harness cannot say.
	Subscription() ([]Window, error)
}

// Store is the saved state.
type Store interface {
	Load() (reconciler.State, error)
}

// Usage is the harnesses' usage as the trierarch's report carries it.
type Usage struct {
	Subscriptions []Subscription `json:"subscriptions"`
	Ships         []ShipUsage    `json:"ships"`
}

// Subscription is a harness's subscription windows, and when they were read.
type Subscription struct {
	Harness string         `json:"harness"`
	ReadAt  string         `json:"readAt"`
	Windows []WindowReport `json:"windows"`
}

// WindowReport is a window as the report says it.
type WindowReport struct {
	WindowMinutes float64 `json:"windowMinutes"`
	UsedPercent   float64 `json:"usedPercent"`
	ResetsAt      string  `json:"resetsAt"`
}

// ShipUsage is a crewed ship's tokens per model and login.
type ShipUsage struct {
	ShipID string       `json:"shipId"`
	Models []ModelUsage `json:"models"`
}

// ModelUsage is a ship's tokens of one model and login, with what they cost at its price; no cost for a model the prices do not name.
type ModelUsage struct {
	Model            string   `json:"model"`
	Login            string   `json:"login,omitempty"`
	Tokens           Tokens   `json:"tokens"`
	EstimatedCostUSD *float64 `json:"estimatedCostUsd"`
}

// subscriptionRead is a harness's subscription as last read: its windows, none when it could not say, when, and its ships' tokens then.
type subscriptionRead struct {
	windows []Window
	at      time.Time
	tokens  float64
}

// Reader reads the harnesses' usage. Every 5 minutes it reads the tokens each ship it crews used per model and login (api keys K8), since its folder was made, and estimates their cost from the prices. A harness's subscription is read at start, then again only once 30 minutes passed and the harness's ships did work since: Claude Code's read is a turn of its own. A read that fails keeps what was read before.
type Reader struct {
	// Harnesses are the readers by harness; a harness with none says nothing.
	Harnesses map[string]Harness
	// Configured are the configured harnesses, in order: each one's subscription is read.
	Configured []string
	Store      Store
	Prices     map[string]config.Price
	Now        func() time.Time
	Log        func(line string)

	ships           []ShipUsage
	tokensReadAt    time.Time
	tokensByHarness map[string]float64
	subscriptions   map[string]subscriptionRead
}

// Read is the usage now, each part read again when its interval passed.
func (r *Reader) Read() (Usage, error) {
	now := r.Now()
	if r.tokensReadAt.IsZero() || now.Sub(r.tokensReadAt) >= TokensReadEvery {
		if err := r.readTokens(); err != nil {
			return Usage{}, err
		}
		r.tokensReadAt = now
	}
	for _, harness := range r.Configured {
		r.readSubscription(harness, now)
	}
	read := Usage{Subscriptions: []Subscription{}, Ships: append([]ShipUsage{}, r.ships...)}
	for _, harness := range r.Configured {
		last, ok := r.subscriptions[harness]
		if !ok || last.windows == nil {
			continue
		}
		windows := []WindowReport{}
		for _, window := range last.windows {
			windows = append(windows, WindowReport{WindowMinutes: window.WindowMinutes, UsedPercent: window.UsedPercent, ResetsAt: isoOf(window.ResetsAt)})
		}
		read.Subscriptions = append(read.Subscriptions, Subscription{Harness: harness, ReadAt: isoOf(last.at), Windows: windows})
	}
	return read, nil
}

func (r *Reader) readTokens() error {
	state, err := r.Store.Load()
	if err != nil {
		return err
	}
	read := []ShipUsage{}
	totals := map[string]float64{}
	for _, id := range slices.Sorted(maps.Keys(state.Entries)) {
		entry := state.Entries[id]
		if entry.Folder == "" {
			continue
		}
		ship := Ship{ShipID: entry.ShipID, Folder: entry.Folder, ShipFolder: entry.ShipFolder}
		if entry.Login != "" {
			ship.Logins = &Logins{Login: entry.Login, Earlier: entry.EarlierLogins}
		}
		usage, ok := r.shipUsageOf(entry.Harness, ship)
		if !ok || len(usage.Models) == 0 {
			continue
		}
		read = append(read, usage)
		for _, model := range usage.Models {
			totals[entry.Harness] += model.Tokens.total()
		}
	}
	r.ships, r.tokensByHarness = read, totals
	return nil
}

// shipUsageOf is the ship's tokens per model and login as its harness says them now, or as read before when it cannot say; false when neither is known.
func (r *Reader) shipUsageOf(harness string, ship Ship) (ShipUsage, bool) {
	reader, ok := r.Harnesses[harness]
	if !ok {
		return ShipUsage{ShipID: ship.ShipID}, true
	}
	hours, err := reader.TokensOf(ship)
	if err != nil {
		r.Log(fmt.Sprintf("Could not read the usage of %s: %v", ship.ShipID, err))
		at := slices.IndexFunc(r.ships, func(each ShipUsage) bool { return each.ShipID == ship.ShipID })
		if at < 0 {
			return ShipUsage{}, false
		}
		return r.ships[at], true
	}
	usage := ShipUsage{ShipID: ship.ShipID, Models: []ModelUsage{}}
	for _, model := range perModelOf(hours) {
		model.EstimatedCostUSD = EstimatedCostUSD(model.Tokens, r.Prices, model.Model)
		usage.Models = append(usage.Models, model)
	}
	return usage, true
}

// perModelOf is a ship's tokens added up per model and login over the hours, in the order they came: the report says no hours.
func perModelOf(hours []HourTokens) []ModelUsage {
	var models []ModelUsage
	for _, hour := range hours {
		at := slices.IndexFunc(models, func(each ModelUsage) bool { return each.Model == hour.Model && each.Login == hour.Login })
		if at < 0 {
			models = append(models, ModelUsage{Model: hour.Model, Login: hour.Login, Tokens: hour.Tokens})
			continue
		}
		models[at].Tokens = models[at].Tokens.Plus(hour.Tokens)
	}
	return models
}

func (r *Reader) readSubscription(harness string, now time.Time) {
	tokens := r.tokensByHarness[harness]
	last, isRead := r.subscriptions[harness]
	if isRead && (now.Sub(last.at) < SubscriptionReadEvery || tokens == last.tokens) {
		return
	}
	var windows []Window
	if reader, ok := r.Harnesses[harness]; ok {
		read, err := reader.Subscription()
		if err != nil {
			r.Log(fmt.Sprintf("Could not read the %s subscription: %v", harness, err))
		}
		windows = read
	}
	if r.subscriptions == nil {
		r.subscriptions = map[string]subscriptionRead{}
	}
	if windows == nil && last.windows != nil {
		last.tokens = tokens
		r.subscriptions[harness] = last
		return
	}
	r.subscriptions[harness] = subscriptionRead{windows: windows, at: now, tokens: tokens}
}

// isoOf is the time as JavaScript's toISOString says it, as today's trierarch reports it: UTC, to the millisecond.
func isoOf(at time.Time) string {
	return at.UTC().Format("2006-01-02T15:04:05.000Z")
}
