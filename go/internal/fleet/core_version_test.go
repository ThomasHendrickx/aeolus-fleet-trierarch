package fleet

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"
)

func TestTheMinimumCoreVersionIsTodaysTrierarchs(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	text, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "..", "packages", "trierarch", "src", "adapters", "core-version.ts"))
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`MINIMUM_CORE_VERSION = '([^']+)'`).FindSubmatch(text)

	if match == nil || string(match[1]) != MinimumCoreVersion {
		t.Fatalf("today's trierarch needs core %s, the Go trierarch %s", match, MinimumCoreVersion)
	}
}
