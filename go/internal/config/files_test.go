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
	written.WorktreeRoot = "/work"
	written.Repositories["aeolus-fleet"] = Repository{Path: "/src/aeolus-fleet"}
	if err := Write(path, written); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load(path)

	if err != nil {
		t.Fatal(err)
	}
	if loaded.WorktreeRoot != "/work" || loaded.Repositories["aeolus-fleet"].Path != "/src/aeolus-fleet" || loaded.Caps != (Caps{Ships: 4, Running: 2}) {
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

func TestLoadsTheAipServerAndTheNameOfTheSecretItsReadTokenIs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	text := `{"caps":{"ships":4,"running":2},"repositories":{},"folders":{},"harnesses":{},"aip":{"server":"https://aip.example.invalid","tokenSecret":"aip-read"}}`
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load(path)

	if err != nil {
		t.Fatal(err)
	}
	if loaded.Aip == nil || *loaded.Aip != (Aip{Server: "https://aip.example.invalid", TokenSecret: "aip-read"}) {
		t.Errorf("loaded aip %+v, want the server and the secret's name", loaded.Aip)
	}
}

func TestRefusesAnAipThatDoesNotFit(t *testing.T) {
	for name, aip := range map[string]string{
		"no server":           `{"tokenSecret":"aip-read"}`,
		"no token secret":     `{"server":"https://aip.example.invalid"}`,
		"a server not a URL":  `{"server":"aip.example.invalid","tokenSecret":"aip-read"}`,
		"a server not HTTP":   `{"server":"ftp://aip.example.invalid","tokenSecret":"aip-read"}`,
		"a secret not a name": `{"server":"https://aip.example.invalid","tokenSecret":"../aip-read"}`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			text := `{"caps":{"ships":4,"running":2},"repositories":{},"folders":{},"harnesses":{},"aip":` + aip + `}`
			if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
				t.Fatal(err)
			}

			if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "aip") {
				t.Errorf("Load(aip %s) err %v, want a refusal naming aip", aip, err)
			}
		})
	}
}
