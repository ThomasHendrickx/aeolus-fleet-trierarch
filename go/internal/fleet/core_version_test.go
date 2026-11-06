package fleet

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"testing"
)

// TestTheMinimumCoreVersionIsNotOlderThanTodaysTrierarchs: the Go trierarch needs at least what today's does, and 0.38.0, the core that takes a crew request's mcpServers.
func TestTheMinimumCoreVersionIsNotOlderThanTodaysTrierarchs(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	text, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "..", "packages", "trierarch", "src", "adapters", "core-version.ts"))
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`MINIMUM_CORE_VERSION = '([^']+)'`).FindSubmatch(text)

	if match == nil || slices.Compare(versionOf(MinimumCoreVersion), versionOf(string(match[1]))) < 0 {
		t.Fatalf("today's trierarch needs core %s, the Go trierarch %s", match, MinimumCoreVersion)
	}
}

func TestTheMinimumCoreVersionTakesACrewRequestsMcpServers(t *testing.T) {
	if slices.Compare(versionOf(MinimumCoreVersion), []int{0, 38, 0}) < 0 {
		t.Fatalf("the Go trierarch needs core %s, and core takes mcpServers from 0.38.0", MinimumCoreVersion)
	}
}
