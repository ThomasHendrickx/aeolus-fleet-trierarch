package cli

import (
	"errors"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
)

func TestInstallLoadsTheServiceAndSaysWhereItsFileAndItsLogsAre(t *testing.T) {
	machine, installed, _ := aMain(t)

	output, code := Main([]string{"install"}, machine)

	logs := trierarchHome(machine).Logs
	if code != 0 || !slices.Equal(installed.calls, []string{"install"}) || output != "Installed /unit. Logs: "+logs {
		t.Fatalf("answered %q, %d, service %q", output, code, installed.calls)
	}
}

func TestInstallAnswersTheServiceAsJSON(t *testing.T) {
	machine, _, _ := aMain(t)

	output, code := Main([]string{"install", "--json"}, machine)

	want := map[string]any{"file": "/unit", "isInstalled": true, "isRunning": true, "pid": float64(41)}
	if got := decoded(t, output); code != 0 || !reflect.DeepEqual(got, want) {
		t.Fatalf("answered %q, %d", output, code)
	}
}

func TestInstallSaysWhenTheNewProcessHasNotSaidItsVersion(t *testing.T) {
	machine, installed, _ := aMain(t)
	installed.write = func() {}

	output, code := Main([]string{"install"}, machine)

	if code != 0 || !strings.HasSuffix(output, notSaidYet) {
		t.Fatalf("answered %q, %d", output, code)
	}
}

func TestInstallWithoutLoadOnlyWritesTheServicesFile(t *testing.T) {
	machine, installed, _ := aMain(t)
	installed.write = func() { t.Errorf("a process started") }

	output, code := Main([]string{"install", "--no-load"}, machine)

	logs := trierarchHome(machine).Logs
	if code != 0 || !slices.Equal(installed.calls, []string{"write"}) || output != "Installed /unit. Logs: "+logs {
		t.Fatalf("answered %q, %d, service %q", output, code, installed.calls)
	}
}

func TestInstallWithoutLoadAnswersTheServiceAsJSONNotRunning(t *testing.T) {
	machine, _, _ := aMain(t)

	output, code := Main([]string{"install", "--no-load", "--json"}, machine)

	want := map[string]any{"file": "/unit", "isInstalled": true, "isRunning": false}
	if got := decoded(t, output); code != 0 || !reflect.DeepEqual(got, want) {
		t.Fatalf("answered %q, %d", output, code)
	}
}

func TestInstallWritesTheConfigurationsJSONSchema(t *testing.T) {
	machine, _, _ := aMain(t)

	Main([]string{"install", "--no-load"}, machine)

	if _, err := os.Stat(trierarchHome(machine).ConfigSchema); err != nil {
		t.Errorf("config.schema.json is not written: %v", err)
	}
}

func TestInstallSaysWhyTheServiceCouldNotBeInstalled(t *testing.T) {
	machine, _, _ := aMain(t)
	machine.Service = func(paths.Paths) ServiceManager { return &aRefusingService{} }

	output, code := Main([]string{"install"}, machine)

	if code != 1 || output != "launchctl bootstrap failed" {
		t.Fatalf("answered %q, %d", output, code)
	}
}

// aRefusingService is a service the operating system refuses to install.
type aRefusingService struct {
	anInstalledService
}

func (s *aRefusingService) Install() error {
	return errors.New("launchctl bootstrap failed")
}
