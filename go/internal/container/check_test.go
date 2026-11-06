package container

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

// aHost is the machine as the check reads it: how the runtime runs, the user's groups, and whether the model token is written.
type aHost struct {
	mode      Mode
	groups    []string
	groupsErr error
	isWritten bool
	// isPastaMissing is a Podman whose info names no pasta.
	isPastaMissing bool
}

func (h aHost) Mode(binary string) Mode   { return h.mode }
func (h aHost) Groups() ([]string, error) { return h.groups, h.groupsErr }
func (h aHost) IsModelTokenWritten() bool { return h.isWritten }
func (h aHost) IsPastaMissing(binary string) bool { return h.isPastaMissing }
func aRootlessHost() aHost                { return aHost{mode: Rootless, groups: []string{"user"}, isWritten: true} }
func withHarnesses(names ...string) config.Configuration {
	harnesses := map[string]config.Harness{}
	for _, name := range names {
		harnesses[name] = config.Harness{Flags: []string{}, Options: map[string]config.Option{}}
	}
	return config.Configuration{Harnesses: harnesses, HarnessOrder: names, Runtime: &config.Runtime{Kind: "container", Binary: "podman", Memory: "4g", Cpus: 2}}
}

const modelToken = "/home/user/.aeolus/trierarch/model-token"

func TestCheckRefusesWhatCannotHoldASessionToItsShip(t *testing.T) {
	tests := []struct {
		name          string
		configuration config.Configuration
		host          aHost
		want          []string
	}{
		{"a rootless runtime, Claude Code and the model token", withHarnesses("claude-code"), aRootlessHost(), nil},
		{"Copilot is configured, not offered rather than refused", withHarnesses("claude-code", "copilot"), aRootlessHost(), nil},
		{"a rootful runtime", withHarnesses("claude-code"), aHost{mode: Rootful, groups: []string{"user"}, isWritten: true}, []string{"podman runs rootful: the container runtime runs rootless only, as the user that runs the trierarch"}},
		{"a runtime that does not answer", withHarnesses("claude-code"), aHost{mode: Missing, groups: []string{"user"}, isWritten: true}, []string{"podman does not answer: install a rootless podman, or name the runtime binary in runtime.binary"}},
		{"a user in the docker group", withHarnesses("claude-code"), aHost{mode: Rootless, groups: []string{"user", "docker"}, isWritten: true}, []string{"the user that runs the trierarch is in the docker group, which is root on the machine: take the user out of it"}},
		{"a Podman without pasta", withHarnesses("claude-code"), aHost{mode: Rootless, groups: []string{"user"}, isWritten: true, isPastaMissing: true}, []string{"podman has no pasta: install passt, which gives a container the trierarch's proxy port and nothing else of the host"}},
		{"Codex configured", withHarnesses("claude-code", "codex"), aRootlessHost(), []string{"codex does not run in a container yet: the container runtime offers claude-code only, so remove codex"}},
		{"no model token", withHarnesses("claude-code"), aHost{mode: Rootless, groups: []string{"user"}}, []string{"the model token file " + modelToken + " is missing or empty: write the token claude setup-token gives into it, readable by its owner only"}},
		{
			"every reason, in order", withHarnesses("claude-code", "codex"), aHost{mode: Rootful, groups: []string{"docker"}},
			[]string{
				"podman runs rootful: the container runtime runs rootless only, as the user that runs the trierarch",
				"the user that runs the trierarch is in the docker group, which is root on the machine: take the user out of it",
				"codex does not run in a container yet: the container runtime offers claude-code only, so remove codex",
				"the model token file " + modelToken + " is missing or empty: write the token claude setup-token gives into it, readable by its owner only",
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := Check(test.configuration, test.host, modelToken)
			if err != nil || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("Check = %q, %v, want %q", got, err, test.want)
			}
		})
	}
}

func TestCheckRefusesRemoteControlOnEveryRuntime(t *testing.T) {
	remote := config.Harness{Flags: []string{"--remote-control"}, Options: map[string]config.Option{}}
	onHost := config.Configuration{Harnesses: map[string]config.Harness{"claude-code": remote}, HarnessOrder: []string{"claude-code"}}
	inContainers := withHarnesses("claude-code")
	inContainers.Harnesses["claude-code"] = remote
	want := []string{"claude-code launches with --remote-control: a session the trierarch runs has no terminal and no Remote Control, so remove it"}

	for name, configuration := range map[string]config.Configuration{"on the host": onHost, "in containers": inContainers} {
		t.Run(name, func(t *testing.T) {
			got, err := Check(configuration, aRootlessHost(), modelToken)
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("Check = %q, %v, want %q", got, err, want)
			}
		})
	}
}

func TestCheckAsksNothingOfTheMachineForSessionsOnTheHost(t *testing.T) {
	onHost := config.Configuration{Harnesses: map[string]config.Harness{"codex": {}}, HarnessOrder: []string{"codex"}}

	got, err := Check(onHost, aHost{mode: Missing, groupsErr: errors.New("no id")}, modelToken)

	if err != nil || got != nil {
		t.Fatalf("Check = %q, %v, want none", got, err)
	}
}

func TestCheckFailsWhenTheUsersGroupsCannotBeRead(t *testing.T) {
	_, err := Check(withHarnesses("claude-code"), aHost{mode: Rootless, groupsErr: errors.New("id -Gn failed")}, modelToken)

	if err == nil {
		t.Fatal("Check read no groups and answered no error")
	}
}

func TestRefusalSaysEveryReasonOnItsOwnLine(t *testing.T) {
	got := Refusal("/home/user/.aeolus/trierarch/config.json", []string{"one", "two"}).Error()

	want := "The configuration at /home/user/.aeolus/trierarch/config.json cannot run its sessions in containers:\n  one\n  two"
	if got != want {
		t.Fatalf("Refusal = %q, want %q", got, want)
	}
}

func TestModeOfReadsPodmansAndDockersInfo(t *testing.T) {
	tests := []struct {
		info string
		want Mode
	}{
		{`{"host":{"security":{"rootless":true}}}`, Rootless},
		{`{"host":{"security":{"rootless":false}}}`, Rootful},
		{`{"SecurityOptions":["name=seccomp,profile=builtin","name=rootless"]}`, Rootless},
		{`{"SecurityOptions":["name=seccomp,profile=builtin"]}`, Rootful},
		{`not json`, Missing},
		{`{"other":1}`, Missing},
	}
	for _, test := range tests {
		if got := modeOfInfo(test.info); got != test.want {
			t.Errorf("modeOfInfo(%s) = %v, want %v", test.info, got, test.want)
		}
	}
}

func TestPastaIsMissingOnlyFromAPodmanWhoseInfoNamesNone(t *testing.T) {
	tests := []struct {
		info string
		want bool
	}{
		{`{"host":{"security":{"rootless":true},"pasta":{"executable":"/usr/bin/pasta"}}}`, false},
		{`{"host":{"security":{"rootless":true},"pasta":{"executable":""}}}`, true},
		{`{"host":{"security":{"rootless":true}}}`, true},
		{`{"SecurityOptions":["name=rootless"]}`, false},
		{`not json`, false},
	}
	for _, test := range tests {
		if got := isPastaMissingOfInfo(test.info); got != test.want {
			t.Errorf("isPastaMissingOfInfo(%s) = %v, want %v", test.info, got, test.want)
		}
	}
}

func TestMachineSaysWhetherTheModelTokenIsWritten(t *testing.T) {
	folder := t.TempDir()
	token := filepath.Join(folder, "model-token")
	machine := Machine{ModelToken: token}
	if machine.IsModelTokenWritten() {
		t.Fatal("a missing token file is written")
	}
	if err := os.WriteFile(token, []byte(" \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if machine.IsModelTokenWritten() {
		t.Fatal("a blank token file is written")
	}
	if err := os.WriteFile(token, []byte("sk-ant-oat01-x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !machine.IsModelTokenWritten() {
		t.Fatal("a token file with a token is not written")
	}
}

func TestMachineSaysAModeOfMissingForABinaryThatDoesNotRun(t *testing.T) {
	if got := (Machine{}).Mode(filepath.Join(t.TempDir(), "no-such-podman")); got != Missing {
		t.Fatalf("Mode = %v, want %v", got, Missing)
	}
}
