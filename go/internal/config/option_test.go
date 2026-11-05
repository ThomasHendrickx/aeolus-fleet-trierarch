package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestAnOptionsValuesKeepTheOrderTheyWereWrittenIn(t *testing.T) {
	var option Option
	if err := json.Unmarshal([]byte(`{"values":{"sonnet":["--model","sonnet"],"opus":["--model","opus"],"haiku":["--model","haiku"]},"default":"opus"}`), &option); err != nil {
		t.Fatal(err)
	}

	if got, want := option.Names(), []string{"sonnet", "opus", "haiku"}; !slices.Equal(got, want) {
		t.Errorf("Names() = %v, want %v", got, want)
	}
}

func TestAnOptionIsWrittenWithItsValuesInTheirOrder(t *testing.T) {
	option := Option{Values: map[string][]string{"sonnet": {"--model", "sonnet"}, "opus": {"--model", "opus"}}, Order: []string{"sonnet", "opus"}, Default: "opus"}

	text, err := json.Marshal(option)

	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(text), `{"values":{"sonnet":["--model","sonnet"],"opus":["--model","opus"]},"default":"opus"}`; got != want {
		t.Errorf("json.Marshal(option) = %s, want %s", got, want)
	}
}

func TestAnOptionWithNoOrderNamesItsValuesSorted(t *testing.T) {
	option := Option{Values: map[string][]string{"medium": {"--effort", "medium"}, "high": {"--effort", "high"}}}

	if got, want := option.Names(), []string{"high", "medium"}; !slices.Equal(got, want) {
		t.Errorf("Names() = %v, want %v", got, want)
	}
}

func TestAConfigurationRefusesAnOptionWithAKeyOfAnotherShape(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	text := `{"caps":{"ships":4,"running":2},"repositories":{},"folders":{},"harnesses":{"claude-code":{"flags":[],"options":{"effort":{"values":{},"other":1}}}}}`
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := Load(path); err == nil {
		t.Errorf("Load(%s) = nil error, want a refusal of the key other", text)
	}
}
