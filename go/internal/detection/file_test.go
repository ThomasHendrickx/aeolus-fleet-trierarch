package detection

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// writtenByTodaysTrierarch is detected.json as today's trierarch writes it.
const writtenByTodaysTrierarch = `{
  "claude-code": {
    "version": "2.1.306",
    "detectedAt": "2026-11-04T10:00:00.000Z",
    "confirmedAt": "2026-11-04T10:00:00.000Z",
    "options": {
      "model": {
        "values": {
          "claude-sonnet-5": ["--model", "claude-sonnet-5"],
          "claude-opus-5": ["--model", "claude-opus-5"]
        }
      },
      "effort": {
        "values": {
          "low": ["--effort", "low"],
          "high": ["--effort", "high"]
        }
      }
    },
    "permissionModes": ["acceptEdits", "default", "plan"],
    "refused": [{ "id": "claude-sonnet-5", "at": "2026-11-04T10:05:00.000Z" }]
  },
  "codex": {
    "version": "0.163.0",
    "detectedAt": "2026-11-04T10:00:00.000Z",
    "confirmedAt": null,
    "options": {},
    "problem": "Codex 0.163.0 confirmed none of its catalog's models for this login, so this machine declares no Codex model"
  }
}
`

func TestTheFileReadsWhatTodaysTrierarchWrote(t *testing.T) {
	file := File{Path: filepath.Join(t.TempDir(), "detected.json")}
	if err := os.WriteFile(file.Path, []byte(writtenByTodaysTrierarch), 0o644); err != nil {
		t.Fatal(err)
	}

	detected := file.Load()

	claudeCode := detected["claude-code"]
	if claudeCode.Version != "2.1.306" || *claudeCode.ConfirmedAt != "2026-11-04T10:00:00.000Z" || !reflect.DeepEqual(claudeCode.Options[ModelOption].Names(), []string{"claude-sonnet-5", "claude-opus-5"}) {
		t.Errorf("claude-code = %+v, want 2.1.306 confirmed with claude-sonnet-5, claude-opus-5", claudeCode)
	}
	if want := []Refused{{ID: "claude-sonnet-5", At: "2026-11-04T10:05:00.000Z"}}; !reflect.DeepEqual(claudeCode.Refused, want) {
		t.Errorf("refused = %v, want %v", claudeCode.Refused, want)
	}
	if codex := detected["codex"]; codex.ConfirmedAt != nil || codex.Problem == "" {
		t.Errorf("codex = %+v, want none confirmed and its problem", codex)
	}
}

func TestTheFileWritesItAsTodaysTrierarchDoes(t *testing.T) {
	file := File{Path: filepath.Join(t.TempDir(), "trierarch", "detected.json")}
	if err := os.MkdirAll(filepath.Dir(file.Path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file.Path, []byte(writtenByTodaysTrierarch), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := file.Save(file.Load()); err != nil {
		t.Fatal(err)
	}

	text, _ := os.ReadFile(file.Path)
	want := `{
  "claude-code": {
    "version": "2.1.306",
    "detectedAt": "2026-11-04T10:00:00.000Z",
    "confirmedAt": "2026-11-04T10:00:00.000Z",
    "options": {
      "model": {
        "values": {
          "claude-sonnet-5": [
            "--model",
            "claude-sonnet-5"
          ],
          "claude-opus-5": [
            "--model",
            "claude-opus-5"
          ]
        }
      },
      "effort": {
        "values": {
          "low": [
            "--effort",
            "low"
          ],
          "high": [
            "--effort",
            "high"
          ]
        }
      }
    },
    "permissionModes": [
      "acceptEdits",
      "default",
      "plan"
    ],
    "refused": [
      {
        "id": "claude-sonnet-5",
        "at": "2026-11-04T10:05:00.000Z"
      }
    ]
  },
  "codex": {
    "version": "0.163.0",
    "detectedAt": "2026-11-04T10:00:00.000Z",
    "confirmedAt": null,
    "options": {},
    "problem": "Codex 0.163.0 confirmed none of its catalog's models for this login, so this machine declares no Codex model"
  }
}
`
	if string(text) != want {
		t.Errorf("saved\n%s\nwant\n%s", text, want)
	}
}

func TestTheFileSavesInAFolderItMakes(t *testing.T) {
	file := File{Path: filepath.Join(t.TempDir(), "trierarch", "detected.json")}

	if err := file.Save(Detected{"codex": aHarness("0.163.0", "gpt-5.6-terra")}); err != nil {
		t.Fatal(err)
	}

	if got := file.Load()["codex"].Version; got != "0.163.0" {
		t.Errorf("Load() codex version = %q, want 0.163.0", got)
	}
}

func TestAFileThatIsMissingOrDoesNotFitHoldsNothing(t *testing.T) {
	for name, text := range map[string]string{
		"no JSON":         "{",
		"another key":     `{"codex":{"version":"0.163.0","detectedAt":"2026-11-04T10:00:00.000Z","confirmedAt":null,"options":{},"other":1}}`,
		"no version":      `{"codex":{"version":"","detectedAt":"2026-11-04T10:00:00.000Z","confirmedAt":null,"options":{}}}`,
		"not an object":   `[]`,
		"a refused id ''": `{"codex":{"version":"0.163.0","detectedAt":"2026-11-04T10:00:00.000Z","confirmedAt":null,"options":{},"refused":[{"id":"","at":"2026-11-04T10:00:00.000Z"}]}}`,
	} {
		t.Run(name, func(t *testing.T) {
			file := File{Path: filepath.Join(t.TempDir(), "detected.json")}
			if err := os.WriteFile(file.Path, []byte(text), 0o644); err != nil {
				t.Fatal(err)
			}

			if got := file.Load(); len(got) != 0 {
				t.Errorf("Load() of %s = %v, want nothing", text, got)
			}
		})
	}
	t.Run("missing", func(t *testing.T) {
		if got := (File{Path: filepath.Join(t.TempDir(), "detected.json")}).Load(); len(got) != 0 {
			t.Errorf("Load() = %v, want nothing", got)
		}
	})
}
