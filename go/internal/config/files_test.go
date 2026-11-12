package config

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAFreshInitWritesNoRepositoryNoFolderAndClaudeCodeWithNoFlag(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")

	if err := Write(path, Initial()); err != nil {
		t.Fatal(err)
	}

	text, _ := os.ReadFile(path)
	want := `{
  "$schema": "./config.schema.json",
  "caps": {
    "ships": 4,
    "running": 2
  },
  "repositories": {},
  "folders": {},
  "harnesses": {
    "claude-code": {
      "flags": [],
      "options": {}
    }
  }
}
`
	if string(text) != want {
		t.Errorf("wrote\n%s\nwant\n%s", text, want)
	}
}

func TestLoadsTheConfigurationItWrote(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	written := Initial()
	written.ShipsRoot = "/work"
	written.Repositories["aeolus-fleet"] = Repository{Path: "/src/aeolus-fleet"}
	if err := Write(path, written); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load(path)

	if err != nil {
		t.Fatal(err)
	}
	if loaded.ShipsRoot != "/work" || loaded.Repositories["aeolus-fleet"].Path != "/src/aeolus-fleet" || loaded.Caps != (Caps{Ships: 4, Running: 2}) {
		t.Errorf("loaded %+v", loaded)
	}
}

func TestRefusesAConfigurationThatDoesNotFit(t *testing.T) {
	for name, text := range map[string]string{
		"no JSON":       `{`,
		"a key unknown": `{"caps":{"ships":4,"running":2},"repositories":{},"folders":{},"harnesses":{},"remoteControl":true}`,
		"no harnesses":  `{"caps":{"ships":4,"running":2},"repositories":{},"folders":{}}`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
				t.Fatal(err)
			}

			if _, err := Load(path); err == nil || !strings.Contains(err.Error(), path) {
				t.Errorf("err %v, want a refusal naming %s", err, path)
			}
		})
	}
}

func TestRefusesAConfigurationThatIsMissing(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "config.json")); err == nil || !strings.Contains(err.Error(), "run aeolus-trierarch init first") {
		t.Errorf("err %v", err)
	}
}

func TestWritesItsJSONSchemaBesideTheConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "trierarch", "config.schema.json")

	if err := WriteSchema(path); err != nil {
		t.Fatal(err)
	}

	if text, _ := os.ReadFile(path); !bytes.Equal(text, Schema) {
		t.Error("wrote another schema than the one it embeds")
	}
}

func TestLoadsAConfigurationWithALeftoverAipAndSaysItIsNoLongerUsed(t *testing.T) {
	for name, aip := range map[string]string{
		"an aip as it was written": `{"server":"https://aip.example.invalid","tokenSecret":"aip-read"}`,
		"an aip that never fitted": `{"server":"ftp://aip.example.invalid"}`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			text := `{"caps":{"ships":4,"running":2},"repositories":{},"folders":{},"harnesses":{},"aip":` + aip + `}`
			if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
				t.Fatal(err)
			}

			loaded, err := Load(path)

			if err != nil || !loaded.HasLeftoverAip {
				t.Errorf("Load(aip %s) = %+v, %v, want it loaded and the aip said to be left over", aip, loaded, err)
			}
		})
	}
}

func TestAConfigurationWithoutAipHasNoneLeftOver(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"caps":{"ships":4,"running":2},"repositories":{},"folders":{},"harnesses":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	if loaded, err := Load(path); err != nil || loaded.HasLeftoverAip {
		t.Errorf("Load = %+v, %v, want no aip left over", loaded, err)
	}
}

func TestLoadsAConfigurationNamingTheOldWorktreeRootAndSaysSoAndReadsShipsRootAsThePlaceOfShips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	text := `{"caps":{"ships":4,"running":2},"repositories":{},"folders":{},"harnesses":{},"worktreeRoot":"/srv/worktrees","shipsRoot":"/srv/ships"}`
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load(path)

	if err != nil || !loaded.NamesWorktreeRoot || loaded.ShipsRoot != "/srv/ships" {
		t.Errorf("Load = %+v, %v, want worktreeRoot said to be named and shipsRoot read", loaded, err)
	}
}
