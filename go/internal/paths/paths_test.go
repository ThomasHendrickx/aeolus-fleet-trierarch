package paths

import (
	"path/filepath"
	"testing"
)

func TestTheShipsFilesAreUnderShipsBesideTheTrierarchsOwnFiles(t *testing.T) {
	at := Of("/home/me", "")

	if at.Ships != "/home/me/.aeolus/trierarch/ships" {
		t.Fatalf("Ships = %q", at.Ships)
	}
	for _, own := range []string{at.Config, at.CrewToken, at.ModelToken, at.Keys, at.State, at.Sessions, at.Proxy, at.SealingKey} {
		if rel, err := filepath.Rel(at.Ships, own); err != nil || rel == "." || filepath.IsLocal(rel) {
			t.Errorf("%s is under %s", own, at.Ships)
		}
	}
}

func TestAShipsHomeAndSocketsAreInItsShipsFolderOrWhereTheyWereForAShipCrewedBefore(t *testing.T) {
	at := Of("/home/me", "")
	tests := []struct {
		shipFolder, home, sockets string
	}{
		{"/home/me/.aeolus/trierarch/ships/shp_scout", "/home/me/.aeolus/trierarch/ships/shp_scout/home", "/home/me/.aeolus/trierarch/ships/shp_scout/sockets"},
		{"", "/home/me/.aeolus/trierarch/homes/shp_scout", "/home/me/.aeolus/trierarch/sockets/shp_scout"},
	}
	for _, test := range tests {
		if got := ShipHome(at.Homes, "shp_scout", test.shipFolder); got != test.home {
			t.Errorf("ShipHome(%q) = %q, want %q", test.shipFolder, got, test.home)
		}
		if got := ShipSockets(at.Sockets, "shp_scout", test.shipFolder); got != test.sockets {
			t.Errorf("ShipSockets(%q) = %q, want %q", test.shipFolder, got, test.sockets)
		}
	}
}

func TestTheLongestSocketPathUnderAPlaceOfShipsIsItsFleetSocketOfTheLongestShipID(t *testing.T) {
	got := LongestSocket("/home/me/.aeolus/trierarch/ships")

	if want := "/home/me/.aeolus/trierarch/ships/shp_00000000000000000000000000/sockets/fleet.sock"; got != want {
		t.Fatalf("LongestSocket = %q, want %q", got, want)
	}
}

func TestTheSocketPathLimitIsTheSystems(t *testing.T) {
	for system, want := range map[string]int{"linux": 108, "darwin": 104} {
		if got := SocketPathLimit(system); got != want {
			t.Errorf("SocketPathLimit(%s) = %d, want %d", system, got, want)
		}
	}
}
