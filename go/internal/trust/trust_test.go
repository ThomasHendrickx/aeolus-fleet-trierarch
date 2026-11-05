package trust

import (
	"reflect"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

func aConfiguration() config.Configuration {
	configuration := config.Initial()
	configuration.Repositories = map[string]config.Repository{"b-repo": {Path: "/repos/b"}, "a-repo": {Path: "/repos/a"}}
	configuration.Folders = map[string]config.Folder{"notes": {Path: "/notes"}}
	configuration.Harnesses = map[string]config.Harness{"claude-code": {}, "codex": {}, "copilot": {}}
	return configuration
}

func TestEachHarnessTrustsTheConfiguredPlacesItsReaderNamesByPath(t *testing.T) {
	readers := map[string]func() map[string]bool{
		"claude-code": func() map[string]bool { return map[string]bool{"/repos/a": true, "/repos/b": true, "/elsewhere": true} },
		"codex":       func() map[string]bool { return map[string]bool{"/notes": true} },
	}

	got := Of(aConfiguration(), readers)

	want := map[string]Places{
		"claude-code": {Repositories: []string{"a-repo", "b-repo"}, Folders: []string{}},
		"codex":       {Repositories: []string{}, Folders: []string{"notes"}},
		"copilot":     {Repositories: []string{}, Folders: []string{}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Of(...) = %v, want %v", got, want)
	}
}

func TestCopilotAsksAboutNoFolderSoItTrustsEveryConfiguredPlace(t *testing.T) {
	got := Of(aConfiguration(), map[string]func() map[string]bool{"copilot": Everything(aConfiguration())})

	want := Places{Repositories: []string{"a-repo", "b-repo"}, Folders: []string{"notes"}}
	if !reflect.DeepEqual(got["copilot"], want) {
		t.Errorf("copilot trusts %v, want %v", got["copilot"], want)
	}
}
