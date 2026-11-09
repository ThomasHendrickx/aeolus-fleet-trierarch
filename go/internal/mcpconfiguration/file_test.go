package mcpconfiguration

import (
	"errors"
	"maps"
	"os"
	"path/filepath"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpservers"
)

// aConfiguration is a configuration of the configured identity, at the version, sealed to the public key.
func aConfiguration(version int, publicKey string, servers ...string) Configuration {
	configuration := Configuration{Identity: configured, Version: version, PublicKey: publicKey, Servers: []mcpservers.Server{}, Secrets: map[string]string{}}
	for _, name := range servers {
		configuration.Servers = append(configuration.Servers, mcpservers.Server{Name: name, URL: "https://" + name + ".example.test/mcp", Transport: mcpservers.Transport, Tools: []string{"t"}, Credential: &mcpservers.Credential{Secret: name + "-token", Header: "Authorization"}})
		configuration.Secrets[name+"-token"] = "Bearer " + name
	}
	return configuration
}

// aFile is a configuration file in a folder of its own, loaded for the configured identity.
func aFile(t *testing.T) *File {
	t.Helper()
	file := &File{Path: filepath.Join(t.TempDir(), "mcp-configuration.json")}
	file.Load(configured)
	return file
}

func namesOf(configuration Configuration) []string {
	names := []string{}
	for _, server := range configuration.Servers {
		names = append(names, server.Name)
	}
	return names
}

func TestFileHoldsNoneWhenMissing(t *testing.T) {
	file := aFile(t)

	if got, ok := file.Current(); ok {
		t.Errorf("Current() = %+v, true, want none held", got)
	}
}

func TestFileKeepsAnAppliedConfigurationAcrossARestartOnlyItsUserReads(t *testing.T) {
	file := aFile(t)

	outcome, err := file.Apply(aConfiguration(3, "key-a", "company-graph"))

	restarted := &File{Path: file.Path}
	restarted.Load(configured)
	got, ok := restarted.Current()
	info, statErr := os.Stat(file.Path)
	if err != nil || outcome != Applied || !ok || got.Version != 3 || got.PublicKey != "key-a" || len(got.Servers) != 1 || got.Servers[0].Name != "company-graph" || !maps.Equal(got.Secrets, map[string]string{"company-graph-token": "Bearer company-graph"}) {
		t.Errorf("Apply then Load = %v, %v, then %+v, %v, want version 3 with company-graph applied and kept", outcome, err, got, ok)
	}
	if statErr != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("mode of %s = %v, %v, want 600", file.Path, info, statErr)
	}
}

func TestFileTakesTheSameVersionAgainAsUnchanged(t *testing.T) {
	file := aFile(t)
	if _, err := file.Apply(aConfiguration(3, "key-a", "company-graph")); err != nil {
		t.Fatal(err)
	}

	outcome, err := file.Apply(aConfiguration(3, "key-a", "other"))

	got, _ := file.Current()
	if err != nil || outcome != Unchanged || len(got.Servers) != 1 || got.Servers[0].Name != "company-graph" {
		t.Errorf("Apply(duplicate) = %v, %v, holding %v, want unchanged with company-graph", outcome, err, namesOf(got))
	}
}

func TestFileNeverLetsAnOlderVersionRestoreWhatANewerOneRemoved(t *testing.T) {
	file := aFile(t)
	if _, err := file.Apply(aConfiguration(4, "key-a")); err != nil {
		t.Fatal(err)
	}

	outcome, err := file.Apply(aConfiguration(3, "key-a", "company-graph"))

	restarted := &File{Path: file.Path}
	restarted.Load(configured)
	got, _ := restarted.Current()
	if err != nil || outcome != Older || got.Version != 4 || len(got.Servers) != 0 || len(got.Secrets) != 0 {
		t.Errorf("Apply(older) = %v, %v, holding %+v, want older and version 4 with nothing", outcome, err, got)
	}
}

func TestFileTakesTheSameVersionSealedToANewKey(t *testing.T) {
	file := aFile(t)
	if _, err := file.Apply(aConfiguration(3, "key-a", "company-graph")); err != nil {
		t.Fatal(err)
	}

	outcome, err := file.Apply(aConfiguration(3, "key-b", "company-graph"))

	got, _ := file.Current()
	if err != nil || outcome != Applied || got.PublicKey != "key-b" {
		t.Errorf("Apply(new key) = %v, %v, holding key %s, want applied with key-b", outcome, err, got.PublicKey)
	}
}

func TestFileClearsEverythingWithAnEmptyConfiguration(t *testing.T) {
	file := aFile(t)
	if _, err := file.Apply(aConfiguration(3, "key-a", "company-graph")); err != nil {
		t.Fatal(err)
	}

	outcome, err := file.Apply(aConfiguration(4, "key-a"))

	got, ok := file.Current()
	if err != nil || outcome != Applied || !ok || got.Version != 4 || len(got.Servers) != 0 || len(got.Secrets) != 0 {
		t.Errorf("Apply(empty) = %v, %v, holding %+v, want version 4 with nothing", outcome, err, got)
	}
}

func TestFileClearsAConfigurationOfAnotherIdentityBeforeAnyLaunch(t *testing.T) {
	file := aFile(t)
	if _, err := file.Apply(aConfiguration(3, "key-a", "company-graph")); err != nil {
		t.Fatal(err)
	}

	replaced := &File{Path: file.Path}
	replaced.Load(Identity{FleetID: fleetID, PluginShipID: "shp_01m3tb1zhjs6kthtcs2zvksacw"})

	_, statErr := os.Stat(file.Path)
	if got, ok := replaced.Current(); ok || !errors.Is(statErr, os.ErrNotExist) {
		t.Errorf("Load(another plugin ship) = %+v, %v, file %v, want none held and the file gone", got, ok, statErr)
	}
	if got, ok := ReadFile(file.Path); ok {
		t.Errorf("ReadFile after the identity changed = %+v, want none", got)
	}
}

func TestFileHoldsNoneWhenItDoesNotFit(t *testing.T) {
	file := aFile(t)
	if err := os.WriteFile(file.Path, []byte(`{"fleetId":"`+fleetID+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	file.Load(configured)

	if got, ok := file.Current(); ok {
		t.Errorf("Current() = %+v, want none from a file that does not fit", got)
	}
}

func TestFileRefusesALinkInItsPlaceAndKeepsWhatItHolds(t *testing.T) {
	file := aFile(t)
	if _, err := file.Apply(aConfiguration(3, "key-a", "company-graph")); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "elsewhere")
	if err := os.Rename(file.Path, target); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, file.Path); err != nil {
		t.Fatal(err)
	}

	_, err := file.Apply(aConfiguration(4, "key-a"))

	got, _ := file.Current()
	if err == nil || got.Version != 3 {
		t.Errorf("Apply through a link = %v, holding version %d, want a refusal and version 3 held", err, got.Version)
	}
}

func TestReadFileIsWhatTheTrierarchAppliedLast(t *testing.T) {
	file := aFile(t)
	if _, err := file.Apply(aConfiguration(5, "key-a", "company-graph")); err != nil {
		t.Fatal(err)
	}

	got, ok := ReadFile(file.Path)

	if !ok || got.Identity != configured || got.Version != 5 || got.Secrets["company-graph-token"] != "Bearer company-graph" {
		t.Errorf("ReadFile = %+v, %v, want version 5 of the configured identity", got, ok)
	}
}
