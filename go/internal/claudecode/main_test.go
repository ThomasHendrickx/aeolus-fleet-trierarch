package claudecode

import (
	"os"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
)

// TestMain lets this test binary be the trierarch program a hold is started as: `<binary> hold ...`.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "hold" {
		os.Exit(hold.Main(os.Args[2:], "1.2.3", os.Environ()))
	}
	os.Exit(m.Run())
}
