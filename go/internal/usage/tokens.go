package usage

import (
	"cmp"
	"math"
	"slices"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// Tokens are what a ship's sessions used of one model: input not read from a cache, output, and the input read from and written to the prompt cache.
type Tokens struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

// Plus is the tokens of both, kind by kind.
func (t Tokens) Plus(other Tokens) Tokens {
	return Tokens{Input: t.Input + other.Input, Output: t.Output + other.Output, CacheRead: t.CacheRead + other.CacheRead, CacheWrite: t.CacheWrite + other.CacheWrite}
}

func (t Tokens) total() float64 {
	return t.Input + t.Output + t.CacheRead + t.CacheWrite
}

// HourTokens are the tokens of one model and login in one UTC hour, by the time the transcript gives each message or turn; no login when the reader was told none.
type HourTokens struct {
	Model  string
	Login  string
	Hour   time.Time
	Tokens Tokens
}

// hourMs is an hour in milliseconds, the precision a transcript's times have.
const hourMs = int64(time.Hour / time.Millisecond)

// HourOf is the start of the UTC hour the time falls in.
func HourOf(at time.Time) time.Time {
	return time.UnixMilli(at.UnixMilli() / hourMs * hourMs).UTC()
}

type counterKey struct {
	model, login string
	hour         int64
}

// Counter counts a ship's tokens per model, login and UTC hour (api keys K8): what each message used is added to the login of the session that wrote it, in the hour it was used. Its zero value counts nothing yet.
type Counter struct {
	counted map[counterKey]HourTokens
}

// Add adds what one message or turn used.
func (c *Counter) Add(used HourTokens) {
	if c.counted == nil {
		c.counted = map[counterKey]HourTokens{}
	}
	key := counterKey{used.Model, used.Login, used.Hour.UnixMilli()}
	if before, ok := c.counted[key]; ok {
		used.Tokens = before.Tokens.Plus(used.Tokens)
	}
	c.counted[key] = used
}

// List is what was added, in order of model, then login, then hour.
func (c *Counter) List() []HourTokens {
	listed := make([]HourTokens, 0, len(c.counted))
	for _, each := range c.counted {
		listed = append(listed, each)
	}
	slices.SortFunc(listed, func(a, b HourTokens) int {
		return cmp.Or(cmp.Compare(a.Model, b.Model), cmp.Compare(a.Login, b.Login), a.Hour.Compare(b.Hour))
	})
	return listed
}

// Logins are the logins a ship's sessions ran on (api keys K8): its running or last session's, and its earlier sessions' oldest first.
type Logins struct {
	Login   string
	Earlier []reconciler.EarlierLogin
}

// At is the login of the session that ran at the time: what a message written then counts to.
func (l Logins) At(at time.Time) string {
	for _, earlier := range l.Earlier {
		if until, err := time.Parse(time.RFC3339, earlier.Until); err == nil && at.Before(until) {
			return earlier.Login
		}
	}
	return l.Login
}

// listPrices are the list prices of the current Claude and OpenAI models, standard tier, in US dollars per million tokens, as today's trierarch has them (core/token-cost.ts): a Claude cache write at the 1 hour rate, an OpenAI one at its 30 minute rate, or at the input where none is listed.
var listPrices = map[string]config.Price{
	"claude-fable-5-1":  {Input: 10, Output: 50, CacheRead: 0.25, CacheWrite: 20},
	"claude-opus-5-5":   {Input: 4, Output: 20, CacheRead: 0.2, CacheWrite: 8},
	"claude-sonnet-5-5": {Input: 2, Output: 10, CacheRead: 0.2, CacheWrite: 4},
	"claude-haiku-5-5":  {Input: 0.1, Output: 0.5, CacheRead: 0.01, CacheWrite: 0.2},
	"gpt-6-astra":       {Input: 10, Output: 50, CacheRead: 1, CacheWrite: 12.5},
	"gpt-6.1-sol":       {Input: 2, Output: 10, CacheRead: 0.1, CacheWrite: 2.5},
	"gpt-6-sol":         {Input: 2, Output: 10, CacheRead: 0.2, CacheWrite: 2.5},
	"gpt-6-luna":        {Input: 0.1, Output: 0.5, CacheRead: 0.01, CacheWrite: 0.125},
	"gpt-5.6-sol":       {Input: 4, Output: 20, CacheRead: 0.4, CacheWrite: 5},
	"gpt-5.6-terra":     {Input: 2, Output: 12, CacheRead: 0.2, CacheWrite: 2.5},
	"gpt-5.6-luna":      {Input: 0.2, Output: 1.2, CacheRead: 0.02, CacheWrite: 0.25},
	"gpt-5.5":           {Input: 5, Output: 30, CacheRead: 0.5, CacheWrite: 5},
	"gpt-5.3-codex":     {Input: 1.75, Output: 14, CacheRead: 0.175, CacheWrite: 1.75},
}

// PricesOf are the prices the trierarch estimates by: the list prices, with the configuration's own for a model in place of its list price.
func PricesOf(configured map[string]config.Price) map[string]config.Price {
	prices := map[string]config.Price{}
	for model, price := range listPrices {
		prices[model] = price
	}
	for model, price := range configured {
		prices[model] = price
	}
	return prices
}

const (
	tokensPerPrice = 1_000_000
	centsPerDollar = 100
)

// EstimatedCostUSD is what the tokens cost at the model's price, to the cent; none for a model the prices do not name.
func EstimatedCostUSD(tokens Tokens, prices map[string]config.Price, model string) *float64 {
	price, ok := prices[model]
	if !ok {
		return nil
	}
	dollars := (tokens.Input*price.Input + tokens.Output*price.Output + tokens.CacheRead*price.CacheRead + tokens.CacheWrite*price.CacheWrite) / tokensPerPrice
	// As JavaScript's Math.round, which today's trierarch rounds with: half up.
	cost := math.Floor(dollars*centsPerDollar+0.5) / centsPerDollar
	return &cost
}
