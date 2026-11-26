package sessions

import (
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/hold"
)

func TestTheSessionReportsWorkingTimeAcrossHoldReplacement(t *testing.T) {
	runtime := aRuntime(t)
	shipFolder := t.TempDir()
	session := Start{ShipID: scout, Folder: shipFolder, ShipFolder: shipFolder, Harness: "claude-code",
		Command: []string{"sh", "-c", `while read -r line; do sleep 0.1; echo '{"type":"result"}'; done`}}
	if err := runtime.Start(session); err != nil {
		t.Fatal(err)
	}
	if _, known := runtime.WorkingTime(scout, shipFolder, time.Now()); known {
		t.Fatal("a session whose earlier time is missing reports known working time")
	}

	session.MeasureWorkingTime = true
	if err := runtime.Start(session); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Send(scout, "{}"); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the turn completed", func() bool {
		duration, known := hold.ReadWorkingTime(hold.WorkingTimePath(shipFolder), time.Now(), false)
		return known && duration > 0 && strings.Contains(read(hold.FilesOf(runtime.Sessions, scout).Events), "result")
	})
	want, known := runtime.WorkingTime(scout, shipFolder, time.Now())
	if !known || want <= 0 {
		t.Fatalf("working time = %s (known %t), want a positive duration", want, known)
	}

	session.MeasureWorkingTime = false
	if err := runtime.Start(session); err != nil {
		t.Fatal(err)
	}
	got, known := runtime.WorkingTime(scout, shipFolder, time.Now())
	if !known || got != want {
		t.Fatalf("working time after replacing the hold = %s (known %t), want %s", got, known, want)
	}
}
