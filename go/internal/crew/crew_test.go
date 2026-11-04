package crew

import (
	"os"
	"path/filepath"
	"testing"
)

const shipID = "shp_01m6jwb5xwnnezed207ddz58ep"
const pluginShipID = "shp_01m6jwb5xwnnezed207ddz58eq"

func TestKeepsTheFleetURLTheShipAndItsCrewTokenReadableByItsUserOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "trierarch", "crew-token")
	kept := File{FleetURL: "https://fleet.example.com", ShipID: shipID, PluginShipID: pluginShipID, CrewToken: "aeolus_ct_v1_trierarch"}

	if err := Write(path, kept); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode %o, want 600", info.Mode().Perm())
	}
	read, err := Read(path)
	if err != nil {
		t.Fatal(err)
	}
	if read != kept {
		t.Errorf("read %+v, want %+v", read, kept)
	}
}

func TestReadsTheCrewFileTodaysTrierarchWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "crew-token")
	if err := os.WriteFile(path, []byte("fleetUrl=https://fleet.example.com\nshipId="+shipID+"\ncrewToken=aeolus_ct_v1_trierarch\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	read, err := Read(path)

	if err != nil {
		t.Fatal(err)
	}
	if want := (File{FleetURL: "https://fleet.example.com", ShipID: shipID, CrewToken: "aeolus_ct_v1_trierarch"}); read != want {
		t.Errorf("read %+v, want %+v", read, want)
	}
}

func TestRefusesACrewFileWithoutItsCrewToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "crew-token")
	if err := os.WriteFile(path, []byte("fleetUrl=https://fleet.example.com\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := Read(path); err == nil {
		t.Error("read a crew file with no crew token")
	}
}

func TestShipIDs(t *testing.T) {
	for _, tc := range []struct {
		id     string
		isShip bool
	}{
		{shipID, true},
		{"shp_01m6jwb5xwnnezed207ddz58e", false},
		{"msg_01m6jwb5xwnnezed207ddz58ep", false},
		{"shp_81m6jwb5xwnnezed207ddz58ep", false},
		{"shp_01m6jwb5xwnnezed207ddz58eu", false},
	} {
		if IsShipID(tc.id) != tc.isShip {
			t.Errorf("IsShipID(%q) is %v", tc.id, !tc.isShip)
		}
	}
}
