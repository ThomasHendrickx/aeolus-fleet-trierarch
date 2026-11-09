package mcpconfiguration

import (
	"errors"
	"slices"
	"testing"
)

// aFleet is the trierarch's own ship asking and confirming to the plugin ship: what it sent, by content type, or its failure.
type aFleet struct {
	asked     []string
	confirmed []string
	err       error
}

func (f *aFleet) AskForMcpConfiguration(pluginShipID string, payload string) error {
	if f.err != nil {
		return f.err
	}
	f.asked = append(f.asked, pluginShipID+" "+payload)
	return nil
}

func (f *aFleet) ConfirmMcpConfiguration(pluginShipID string, payload string) error {
	if f.err != nil {
		return f.err
	}
	f.confirmed = append(f.confirmed, pluginShipID+" "+payload)
	return nil
}

func TestAskConfirmsThePersistedVersionAndAsksForTheCurrentOneOnceAfterAStart(t *testing.T) {
	file := aFile(t)
	if _, err := file.Apply(aConfiguration(3, "key-a", "company-graph")); err != nil {
		t.Fatal(err)
	}
	fleet := &aFleet{}
	ask := &Ask{Fleet: fleet, File: file, Log: func(string) {}}

	ask.Once()
	ask.Once()

	wantConfirmed := []string{pluginShipID + ` {"fleetId":"` + fleetID + `","pluginShipId":"` + pluginShipID + `","version":3,"publicKey":"key-a"}`}
	wantAsked := []string{pluginShipID + ` {"fleetId":"` + fleetID + `","pluginShipId":"` + pluginShipID + `"}`}
	if !slices.Equal(fleet.confirmed, wantConfirmed) || !slices.Equal(fleet.asked, wantAsked) {
		t.Errorf("confirmed %v, asked %v, want %v and %v", fleet.confirmed, fleet.asked, wantConfirmed, wantAsked)
	}
}

func TestAskOnlyAsksWhenNoConfigurationIsPersisted(t *testing.T) {
	fleet := &aFleet{}

	(&Ask{Fleet: fleet, File: aFile(t), Log: func(string) {}}).Once()

	if len(fleet.confirmed) != 0 || len(fleet.asked) != 1 {
		t.Errorf("confirmed %v, asked %v, want one request alone", fleet.confirmed, fleet.asked)
	}
}

func TestAskAsksAgainOnTheNextPassWhenTheFleetDoesNotTakeIt(t *testing.T) {
	fleet := &aFleet{err: errors.New("the fleet cannot be reached")}
	logged := []string{}
	ask := &Ask{Fleet: fleet, File: aFile(t), Log: func(line string) { logged = append(logged, line) }}

	ask.Once()
	fleet.err = nil
	ask.Once()

	if len(fleet.asked) != 1 || len(logged) != 1 {
		t.Errorf("asked %v, logged %q, want one failure logged and the ask made on the next pass", fleet.asked, logged)
	}
}

func TestAskAsksNothingBeforeTheFileIsLoadedForAnIdentity(t *testing.T) {
	fleet := &aFleet{}

	(&Ask{Fleet: fleet, File: &File{Path: aFile(t).Path + ".unloaded"}, Log: func(string) {}}).Once()

	if len(fleet.asked) != 0 || len(fleet.confirmed) != 0 {
		t.Errorf("asked %v, confirmed %v, want nothing", fleet.asked, fleet.confirmed)
	}
}
