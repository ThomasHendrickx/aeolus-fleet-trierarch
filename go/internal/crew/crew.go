// Package crew is the trierarch's crew file, written by init: the fleet's
// URL, the trierarch's own ship, the trierarch plugin's ship and the crew
// token, readable by its user only, in the lines today's trierarch writes.
package crew

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type File struct {
	FleetURL string
	ShipID   string
	// PluginShipID is the trierarch plugin's ship, the one ship the trusted repositories are taken from; empty on a machine set up before.
	PluginShipID string
	CrewToken    string
}

var shipIDPattern = regexp.MustCompile(`^shp_[0-7][0-9a-hjkmnp-tv-z]{25}$`)

// IsShipID says whether the text is a ship id as common gives one.
func IsShipID(text string) bool {
	return shipIDPattern.MatchString(text)
}

func Write(path string, crew File) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	plugin := ""
	if crew.PluginShipID != "" {
		plugin = "pluginShipId=" + crew.PluginShipID + "\n"
	}
	text := "fleetUrl=" + crew.FleetURL + "\nshipId=" + crew.ShipID + "\n" + plugin + "crewToken=" + crew.CrewToken + "\n"
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func Read(path string) (File, error) {
	text, err := os.ReadFile(path)
	if err != nil {
		return File{}, fmt.Errorf("no crew token at %s: run aeolus-trierarch init first", path)
	}
	fields := map[string]string{}
	for line := range strings.Lines(string(text)) {
		name, value, ok := strings.Cut(strings.TrimRight(line, "\n"), "=")
		if ok && value != "" {
			if _, seen := fields[name]; !seen {
				fields[name] = value
			}
		}
	}
	if fields["fleetUrl"] == "" || fields["crewToken"] == "" {
		return File{}, fmt.Errorf("the crew file at %s lacks its fleetUrl or crewToken line: run aeolus-trierarch init again", path)
	}
	crew := File{FleetURL: fields["fleetUrl"], CrewToken: fields["crewToken"]}
	if IsShipID(fields["shipId"]) {
		crew.ShipID = fields["shipId"]
	}
	if IsShipID(fields["pluginShipId"]) {
		crew.PluginShipID = fields["pluginShipId"]
	}
	return crew, nil
}
