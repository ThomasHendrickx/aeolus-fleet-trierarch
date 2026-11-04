package prompt

import (
	"strings"
	"testing"
)

func TestAFirstPromptEndsWithTheLineThatNoHumanReadsOnALineOfItsOwn(t *testing.T) {
	if got := First("Review PR 12"); !strings.HasPrefix(got, "Review PR 12\n\nNo human reads this terminal.") {
		t.Fatalf("First(%q) = %q, want the line that no human reads on a line of its own", "Review PR 12", got)
	}
}
