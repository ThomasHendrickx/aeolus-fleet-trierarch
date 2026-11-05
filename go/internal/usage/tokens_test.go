package usage

import (
	"reflect"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

func at(text string) time.Time {
	parsed, err := time.Parse(time.RFC3339, text)
	if err != nil {
		panic(err)
	}
	return parsed
}

func TestAnHourIsTheStartOfTheUTCHourATimeFallsIn(t *testing.T) {
	if got, want := HourOf(at("2026-11-05T10:59:59+01:00")), at("2026-11-05T09:00:00Z"); !got.Equal(want) {
		t.Fatalf("HourOf = %v, want %v", got, want)
	}
}

func TestTokensAreCountedPerModelLoginAndHourListedByModelThenLoginThenHour(t *testing.T) {
	var counted Counter
	counted.Add(HourTokens{Model: "claude-opus-5-5", Login: "subscription", Hour: at("2026-11-05T10:00:00Z"), Tokens: Tokens{Input: 1, Output: 2}})
	counted.Add(HourTokens{Model: "claude-haiku-5-5", Hour: at("2026-11-05T10:00:00Z"), Tokens: Tokens{Input: 5}})
	counted.Add(HourTokens{Model: "claude-opus-5-5", Login: "subscription", Hour: at("2026-11-05T09:00:00Z"), Tokens: Tokens{CacheRead: 7}})
	counted.Add(HourTokens{Model: "claude-opus-5-5", Login: "apiKey", Hour: at("2026-11-05T10:00:00Z"), Tokens: Tokens{CacheWrite: 3}})
	counted.Add(HourTokens{Model: "claude-opus-5-5", Login: "subscription", Hour: at("2026-11-05T10:00:00Z"), Tokens: Tokens{Input: 10, Output: 20, CacheRead: 30, CacheWrite: 40}})

	want := []HourTokens{
		{Model: "claude-haiku-5-5", Hour: at("2026-11-05T10:00:00Z"), Tokens: Tokens{Input: 5}},
		{Model: "claude-opus-5-5", Login: "apiKey", Hour: at("2026-11-05T10:00:00Z"), Tokens: Tokens{CacheWrite: 3}},
		{Model: "claude-opus-5-5", Login: "subscription", Hour: at("2026-11-05T09:00:00Z"), Tokens: Tokens{CacheRead: 7}},
		{Model: "claude-opus-5-5", Login: "subscription", Hour: at("2026-11-05T10:00:00Z"), Tokens: Tokens{Input: 11, Output: 22, CacheRead: 30, CacheWrite: 40}},
	}
	if got := counted.List(); !reflect.DeepEqual(got, want) {
		t.Fatalf("List = %+v, want %+v", got, want)
	}
}

func TestAMessageCountsToTheLoginOfTheSessionThatRanWhenItWasWritten(t *testing.T) {
	logins := Logins{Login: "apiKey", Earlier: []reconciler.EarlierLogin{{Login: "subscription", Until: "2026-11-05T10:00:00.000Z"}}}
	cases := []struct {
		at   string
		want string
	}{
		{"2026-11-05T09:59:59Z", "subscription"},
		{"2026-11-05T10:00:00Z", "apiKey"},
		{"2026-11-05T11:00:00Z", "apiKey"},
	}
	for _, each := range cases {
		if got := logins.At(at(each.at)); got != each.want {
			t.Errorf("At(%s) = %q, want %q", each.at, got, each.want)
		}
	}
}

func TestTokensCostTheirModelsPriceToTheCent(t *testing.T) {
	prices := PricesOf(nil)
	cases := []struct {
		name   string
		model  string
		tokens Tokens
		want   float64
	}{
		// 1500 × 4 + 3000 × 20 + 10000 × 0.2 + 3000 × 8 = 92000 millionths of a dollar.
		{"each kind at its own price", "claude-opus-5-5", Tokens{Input: 1500, Output: 3000, CacheRead: 10_000, CacheWrite: 3000}, 0.09},
		// 3000 × 2 + 900 × 12 + 6000 × 0.2 = 18000 millionths: half a cent and more rounds up.
		{"rounded to the cent", "gpt-5.6-terra", Tokens{Input: 3000, Output: 900, CacheRead: 6000}, 0.02},
		{"no tokens cost nothing", "claude-haiku-5-5", Tokens{}, 0},
	}
	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			got := EstimatedCostUSD(each.tokens, prices, each.model)
			if got == nil || *got != each.want {
				t.Fatalf("EstimatedCostUSD(%+v, %s) = %v, want %v", each.tokens, each.model, got, each.want)
			}
		})
	}
}

func TestAModelThePricesDoNotNameHasNoEstimatedCost(t *testing.T) {
	if got := EstimatedCostUSD(Tokens{Input: 10}, PricesOf(nil), "claude-not-priced-1"); got != nil {
		t.Fatalf("EstimatedCostUSD = %v, want none", *got)
	}
}

func TestTheConfigurationsPricesReplaceAModelsListPriceAndAddOthers(t *testing.T) {
	prices := PricesOf(map[string]config.Price{"claude-opus-5-5": {Input: 1}, "a-model-of-our-own": {Output: 2}})
	if got := prices["claude-opus-5-5"]; got != (config.Price{Input: 1}) {
		t.Errorf("claude-opus-5-5 = %+v, want the configured price", got)
	}
	if got := prices["a-model-of-our-own"]; got != (config.Price{Output: 2}) {
		t.Errorf("a-model-of-our-own = %+v, want the configured price", got)
	}
	if got := prices["claude-sonnet-5-5"]; got != (config.Price{Input: 2, Output: 10, CacheRead: 0.2, CacheWrite: 4}) {
		t.Errorf("claude-sonnet-5-5 = %+v, want its list price", got)
	}
}
