package config

import (
	"slices"
	"testing"
)

func TestTheFlagsAreTheHarnesssOwnThenEachPickedOptionsOrItsDefaultTheModelFirst(t *testing.T) {
	harness := Harness{Flags: []string{"--verbose"}, Options: map[string]Option{
		"effort": {Values: map[string][]string{"high": {"--effort", "high"}, "low": {"--effort", "low"}}, Default: "low"},
		"model":  {Values: map[string][]string{"opus": {"--model", "opus"}}},
	}}

	got := harness.EffectiveFlags(map[string]string{"model": "opus"})

	if want := []string{"--verbose", "--model", "opus", "--effort", "low"}; !slices.Equal(got, want) {
		t.Fatalf("EffectiveFlags = %q, want %q", got, want)
	}
}
