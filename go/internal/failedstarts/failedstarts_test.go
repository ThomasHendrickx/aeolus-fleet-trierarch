package failedstarts

import (
	"strings"
	"testing"
	"time"
)

var now = time.Date(2026, 10, 6, 8, 3, 0, 0, time.UTC)

const configuration = `{"caps":{"ships":8,"running":4}}`

func failed(shipID string) Outcome {
	return Outcome{ShipID: shipID, Reason: "no activity within a minute of its start"}
}

// counted counts the failed starts of the ships in turn, all at now.
func counted(shipIDs ...string) (*Starts, bool) {
	var starts *Starts
	isNewlyStopped := false
	for _, shipID := range shipIDs {
		var isNew bool
		starts, isNew = Count(starts, failed(shipID), now, configuration)
		isNewlyStopped = isNewlyStopped || isNew
	}
	return starts, isNewlyStopped
}

func TestTheThirdShipWhoseStartFailedStopsTheMachineOfferingItself(t *testing.T) {
	starts, isNew := counted("shp_a", "shp_b", "shp_c")

	if !isNew || starts.Stopped == nil || starts.Stopped.Since != "2026-10-06T08:03:00.000Z" || starts.Stopped.Configuration != configuration {
		t.Fatalf("starts = %+v, newly stopped %v", starts, isNew)
	}
	if len(starts.ShipIDs) != 3 || starts.At != "2026-10-06T08:03:00.000Z" {
		t.Fatalf("starts = %+v", starts)
	}
}

func TestTwoShipsWhoseStartsFailedDoNotStopIt(t *testing.T) {
	starts, isNew := counted("shp_a", "shp_b")

	if isNew || starts.Stopped != nil {
		t.Fatalf("starts = %+v, newly stopped %v", starts, isNew)
	}
}

func TestAShipWhoseStartFailedTwiceCountsOnce(t *testing.T) {
	starts, _ := counted("shp_a", "shp_a", "shp_a")

	if starts.Stopped != nil || len(starts.ShipIDs) != 1 {
		t.Fatalf("starts = %+v", starts)
	}
}

func TestTheFirstReasonOfTheRunIsKept(t *testing.T) {
	var starts *Starts
	starts, _ = Count(starts, Outcome{ShipID: "shp_a", Reason: "first"}, now, configuration)
	starts, _ = Count(starts, Outcome{ShipID: "shp_b", Reason: "second"}, now, configuration)

	if starts.Reason != "first" {
		t.Fatalf("reason = %q", starts.Reason)
	}
}

func TestAStartThatSucceededClearsTheCount(t *testing.T) {
	starts, _ := counted("shp_a", "shp_b", "shp_c")

	cleared, isNew := Count(starts, Outcome{ShipID: "shp_d", IsSuccess: true}, now, configuration)

	if cleared != nil || isNew {
		t.Fatalf("cleared = %+v, newly stopped %v", cleared, isNew)
	}
}

func TestAFurtherFailureAfterTheStopKeepsTheStopAndTellsNothingNew(t *testing.T) {
	starts, _ := counted("shp_a", "shp_b", "shp_c")
	later := now.Add(12 * time.Minute)

	again, isNew := Count(starts, failed("shp_d"), later, configuration)

	if isNew || again.Stopped == nil || again.Stopped.Since != "2026-10-06T08:03:00.000Z" || again.At != "2026-10-06T08:15:00.000Z" {
		t.Fatalf("again = %+v, newly stopped %v", again, isNew)
	}
}

func TestAnotherConfigurationThanItStoppedWithCountsAfresh(t *testing.T) {
	starts, _ := counted("shp_a", "shp_b", "shp_c")

	if got := WithConfiguration(starts, `{"caps":{"ships":6,"running":4}}`); got != nil {
		t.Fatalf("got %+v", got)
	}
	if got := WithConfiguration(starts, configuration); got != starts {
		t.Fatalf("got %+v", got)
	}
}

func TestAnotherConfigurationClearsNothingBeforeItStopped(t *testing.T) {
	starts, _ := counted("shp_a", "shp_b")

	if got := WithConfiguration(starts, "another"); got != starts {
		t.Fatalf("got %+v", got)
	}
}

func TestItOffersItselfUnlessItStoppedAndItsProbeIsNotDue(t *testing.T) {
	starts, _ := counted("shp_a", "shp_b", "shp_c")
	two, _ := counted("shp_a", "shp_b")

	cases := []struct {
		name      string
		starts    *Starts
		at        time.Time
		isOffered bool
		isProbing bool
	}{
		{"none failed", nil, now, true, false},
		{"two failed", two, now, true, false},
		{"stopped", starts, now, false, false},
		{"one second before its probe", starts, now.Add(10*time.Minute - time.Second), false, false},
		{"its probe is due", starts, now.Add(10 * time.Minute), true, true},
	}
	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			if got := IsOffering(each.starts, each.at); got != each.isOffered {
				t.Fatalf("IsOffering = %v, want %v", got, each.isOffered)
			}
			if got := IsProbing(each.starts, each.at); got != each.isProbing {
				t.Fatalf("IsProbing = %v, want %v", got, each.isProbing)
			}
		})
	}
}

func TestAProbeHasRoomForOneStartAboveTheShipsItHoldsWhileNoStartIsUndecided(t *testing.T) {
	cases := []struct {
		name                   string
		held, ships, want      int
		isStartUndecided       bool
	}{
		{"one more", 1, 8, 2, false},
		{"none held", 0, 8, 1, false},
		{"a start undecided", 1, 8, 1, true},
		{"never above the cap", 8, 8, 8, false},
	}
	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			if got := ProbeShipsCap(each.held, each.ships, each.isStartUndecided); got != each.want {
				t.Fatalf("ProbeShipsCap = %d, want %d", got, each.want)
			}
		})
	}
}

func TestTheReasonItIsNotOfferedNamesTheShipsTheFirstReasonAndWhenItOffersItselfAgain(t *testing.T) {
	starts, _ := counted("shp_a", "shp_b", "shp_c")

	got := NotOfferedReason(*starts)

	want := "the starts of 3 ships failed in a row; first: no activity within a minute of its start; it offers itself again at 2026-10-06T08:13:00.000Z"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestALongFirstReasonIsCutSoTheWholeReasonFitsTheReportsLimit(t *testing.T) {
	var starts *Starts
	for _, shipID := range []string{"shp_a", "shp_b", "shp_c"} {
		starts, _ = Count(starts, Outcome{ShipID: shipID, Reason: strings.Repeat("é", 400)}, now, configuration)
	}

	got := NotOfferedReason(*starts)

	if units := len([]rune(got)); units != 280 || !strings.HasSuffix(got, "; it offers itself again at 2026-10-06T08:13:00.000Z") {
		t.Fatalf("length %d: %q", units, got)
	}
}
