package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func harness(flags ...string) Harness {
	return Harness{Flags: append([]string{}, flags...), Options: map[string]Option{}}
}

func TestWithoutRemoteControlTakesItOutOfEachHarnessWithTheNameGivenAfterItOrWithEquals(t *testing.T) {
	configured := Initial()
	configured.Harnesses = map[string]Harness{
		"claude-code": harness("--remote-control", "mine", "--verbose"),
		"lookout":     harness("--remote-control=lookout"),
		"codex":       harness("--dangerously-bypass-approvals-and-sandbox"),
	}

	without, harnesses := configured.WithoutRemoteControl()

	want := map[string]Harness{
		"claude-code": harness("--verbose"),
		"lookout":     harness(),
		"codex":       harness("--dangerously-bypass-approvals-and-sandbox"),
	}
	if !reflect.DeepEqual(without.Harnesses, want) {
		t.Errorf("harnesses %+v, want %+v", without.Harnesses, want)
	}
	if !reflect.DeepEqual(harnesses, []string{"claude-code", "lookout"}) {
		t.Errorf("named %v", harnesses)
	}
	if len(configured.Harnesses["claude-code"].Flags) != 3 {
		t.Errorf("changed the configuration it was given: %v", configured.Harnesses["claude-code"].Flags)
	}
}

func TestWithoutRemoteControlKeepsAFlagAfterItThatIsNoNameAndTakesItOutOfAnOptionsValuesToo(t *testing.T) {
	configured := Initial()
	configured.Harnesses = map[string]Harness{"claude-code": {
		Flags:   []string{"--remote-control", "--verbose"},
		Options: map[string]Option{"remote": {Values: map[string][]string{"on": {"--remote-control"}, "off": {}}, Default: "off", Order: []string{"on", "off"}}},
	}}

	without, harnesses := configured.WithoutRemoteControl()

	want := Harness{Flags: []string{"--verbose"}, Options: map[string]Option{"remote": {Values: map[string][]string{"on": {}, "off": {}}, Default: "off", Order: []string{"on", "off"}}}}
	if !reflect.DeepEqual(without.Harnesses["claude-code"], want) || !reflect.DeepEqual(harnesses, []string{"claude-code"}) {
		t.Errorf("got %+v, %v", without.Harnesses["claude-code"], harnesses)
	}
}

func TestWithoutRemoteControlNamesNoHarnessForAConfigurationWithoutIt(t *testing.T) {
	configured := Initial()
	configured.Harnesses["claude-code"] = harness("--verbose")

	without, harnesses := configured.WithoutRemoteControl()

	if !reflect.DeepEqual(without, configured) || len(harnesses) != 0 {
		t.Errorf("got %+v, %v", without, harnesses)
	}
}

func TestRemoveRemoteControlRewritesTheFileKeepingAllElseAndNamesTheHarness(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	configured := Initial()
	configured.ShipsRoot = "/ships"
	configured.Harnesses["claude-code"] = harness("--remote-control", "--verbose")
	if err := Write(path, configured); err != nil {
		t.Fatal(err)
	}

	named, err := RemoveRemoteControl(path)
	if err != nil {
		t.Fatal(err)
	}

	if !reflect.DeepEqual(named, []string{"claude-code"}) {
		t.Errorf("named %v", named)
	}
	want := configured
	want.Harnesses = map[string]Harness{"claude-code": harness("--verbose")}
	want.HarnessOrder = []string{"claude-code"}
	loaded, err := Load(path)
	if err != nil || !reflect.DeepEqual(loaded, want) {
		t.Errorf("loaded %+v, %v; want %+v", loaded, err, want)
	}
	if text, _ := os.ReadFile(path); !strings.HasSuffix(string(text), "}\n") || !strings.Contains(string(text), "  \"shipsRoot\"") {
		t.Errorf("wrote %s", text)
	}
}

func TestRemoveRemoteControlLeavesAFileWithoutItAsItIsAndAMissingOrMisfitOne(t *testing.T) {
	folder := t.TempDir()
	path := filepath.Join(folder, "config.json")
	text := `{"caps":{"ships":4,"running":2},"repositories":{},"folders":{},"harnesses":{"claude-code":{"flags":["--verbose"],"options":{}}}}`
	misfit := filepath.Join(folder, "misfit.json")
	for file, content := range map[string]string{path: text, misfit: `{"harnesses":{"c":{"flags":["--remote-control"],"options":{}}}}`} {
		if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	for _, file := range []string{path, filepath.Join(folder, "none.json"), misfit} {
		if named, err := RemoveRemoteControl(file); len(named) != 0 || err != nil {
			t.Errorf("%s named %v", file, named)
		}
	}
	if kept, _ := os.ReadFile(path); string(kept) != text {
		t.Errorf("changed the file: %s", kept)
	}
}
