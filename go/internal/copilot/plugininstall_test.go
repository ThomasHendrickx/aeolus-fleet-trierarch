package copilot

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// aCopilot is a `copilot` that keeps each command line it is given and lists the marketplaces named in its marketplaces file. A file `fails` makes every command fail.
type aCopilot struct {
	folder string
}

func aCopilotWith(t *testing.T, marketplaces string) aCopilot {
	t.Helper()
	folder := t.TempDir()
	if err := os.WriteFile(filepath.Join(folder, "marketplaces"), []byte(marketplaces), 0o644); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
echo "$*" >> '` + folder + `/calls.txt'
if [ -e '` + folder + `/fails' ]; then echo 'Failed to reach github.com' >&2; exit 1; fi
if [ "$2 $3" = "marketplace list" ]; then cat '` + folder + `/marketplaces'; fi
exit 0
`
	if err := os.WriteFile(filepath.Join(folder, "copilot"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return aCopilot{folder: folder}
}

func (c aCopilot) calls(t *testing.T) []string {
	t.Helper()
	text, err := os.ReadFile(filepath.Join(c.folder, "calls.txt"))
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimSpace(string(text)), "\n")
}

func (c aCopilot) install(tag string) error {
	return PluginInstall{Program: filepath.Join(c.folder, "copilot")}.Install(tag)
}

func TestInstallAddsTheMarketplaceItLacksAtTheTagBeforeInstallingThePlugin(t *testing.T) {
	copilot := aCopilotWith(t, "Registered marketplaces:\n  github (GitHub)\n")

	if err := copilot.install("v0.41.0"); err != nil {
		t.Fatal(err)
	}

	want := []string{
		"plugin marketplace list",
		"plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch#v0.41.0",
		"plugin install aeolus-fleet@aeolus-fleet",
	}
	if got := copilot.calls(t); !reflect.DeepEqual(got, want) {
		t.Errorf("ran %q, want %q", got, want)
	}
}

// Copilot lists no marketplace's ref and refuses to add a marketplace it has, so the one it has is removed, with the plugin it installed from it, and added again at the tag.
func TestInstallAddsTheMarketplaceItHasAgainAtTheTag(t *testing.T) {
	copilot := aCopilotWith(t, "Registered marketplaces:\n  aeolus-fleet (ThomasHendrickx/aeolus-fleet-trierarch)\n")

	if err := copilot.install("v0.41.0"); err != nil {
		t.Fatal(err)
	}

	want := []string{
		"plugin marketplace list",
		"plugin marketplace remove --force aeolus-fleet",
		"plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch#v0.41.0",
		"plugin install aeolus-fleet@aeolus-fleet",
	}
	if got := copilot.calls(t); !reflect.DeepEqual(got, want) {
		t.Errorf("ran %q, want %q", got, want)
	}
}

func TestInstallKeepsWhatCopilotSaidWhenACommandFails(t *testing.T) {
	copilot := aCopilotWith(t, "")
	if err := os.WriteFile(filepath.Join(copilot.folder, "fails"), nil, 0o644); err != nil {
		t.Fatal(err)
	}

	err := copilot.install("v0.41.0")

	if err == nil || !strings.Contains(err.Error(), "Failed to reach github.com") {
		t.Errorf("error = %v, want what Copilot said", err)
	}
}

func TestInstallKeepsAndNamesTheErrorWhenCopilotCannotStart(t *testing.T) {
	err := PluginInstall{Program: filepath.Join(t.TempDir(), "copilot")}.Install("v0.41.0")

	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("error = %v, want the execution error kept for errors.Is", err)
	}
	if !strings.Contains(err.Error(), "copilot") {
		t.Errorf("error %q does not name the harness", err)
	}
}
