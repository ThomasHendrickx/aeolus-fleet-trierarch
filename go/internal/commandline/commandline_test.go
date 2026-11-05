package commandline

import (
	"slices"
	"testing"
)

func TestDescribeGivesEachFlagPartItsSourceAndWhen(t *testing.T) {
	parts := []Part{
		{Words: []string{"claude"}},
		{Words: []string{"--model", "opus"}, Source: Configuration},
		{Words: []string{"--permission-mode", "manual"}, Source: Adapter, When: "the settings say so"},
		{Words: []string{"--", "two words\nand a break"}},
	}

	want := `claude --model opus (configuration) --permission-mode manual (adapter, when the settings say so) -- "two words\nand a break"`
	if got := Describe(parts); got != want {
		t.Errorf("described %q, want %q", got, want)
	}
}

func TestWordsAreThePartsWordsInOrder(t *testing.T) {
	parts := []Part{{Words: []string{"a"}}, {Words: []string{"b", "c"}, Source: Adapter}}

	if got := Words(parts); !slices.Equal(got, []string{"a", "b", "c"}) {
		t.Errorf("words %v", got)
	}
}

func TestWithWordsDropsThePartsWithNone(t *testing.T) {
	parts := WithWords([]Part{{Words: []string{"a"}}, {Words: nil, Source: Configuration}, {Words: []string{}, Source: Adapter}})

	if len(parts) != 1 || parts[0].Words[0] != "a" {
		t.Errorf("parts %v", parts)
	}
}
