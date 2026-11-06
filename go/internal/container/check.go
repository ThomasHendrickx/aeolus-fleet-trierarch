// Package container is the container session runtime (decision 0039): the
// check that refuses a runtime that cannot hold a session to its ship, and a
// container per ship, run by its hold.
package container

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

// Mode is how a container runtime runs: rootless, rootful, or missing when it does not answer.
type Mode string

const (
	Rootless Mode = "rootless"
	Rootful  Mode = "rootful"
	Missing  Mode = "missing"
)

// Host is the machine as the check reads it.
type Host interface {
	// Mode is how the runtime binary runs.
	Mode(binary string) Mode
	// Groups are the groups of the user that runs the trierarch.
	Groups() ([]string, error)
	IsModelTokenWritten() bool
	// IsPastaMissing is whether the runtime is a Podman whose info names no pasta, the network that gives a container the proxy's port alone.
	IsPastaMissing(binary string) bool
}

// harnesses are the harnesses a container runs, until another is proven in one (decision 0039).
var harnesses = []string{"claude-code"}

// notOffered are the harnesses the configuration may hold in container mode, which the trierarch then names as not offered rather than refusing it (CC10).
var notOffered = []string{"copilot"}

// dockerGroup is the group whose members drive a rootful docker daemon: root on the machine.
const dockerGroup = "docker"

// Check is why the configuration's sessions cannot run on the machine, one reason each, none when they can. A runtime holds a session to its own ship only when it is rootless and the user is no docker group member, both root on the machine otherwise; a container session runs Claude Code only, with the machine's model token. Sessions on the host need none of it, so nothing is asked of the machine. No session the trierarch runs has a terminal, so none has Remote Control, on any runtime (headless H20).
func Check(configuration config.Configuration, host Host, modelToken string) ([]string, error) {
	var remoteControl []string
	for _, name := range configuration.HarnessOrder {
		if harness, ok := configuration.Harnesses[name]; ok && harness.CarriesRemoteControl() {
			remoteControl = append(remoteControl, fmt.Sprintf("%s launches with %s: a session the trierarch runs has no terminal and no Remote Control, so remove it", name, config.RemoteControlFlag))
		}
	}
	runtime := configuration.Runtime
	if runtime == nil || runtime.Kind != "container" {
		return remoteControl, nil
	}
	var refusals []string
	switch host.Mode(runtime.Binary) {
	case Rootful:
		refusals = append(refusals, runtime.Binary+" runs rootful: the container runtime runs rootless only, as the user that runs the trierarch")
	case Missing:
		refusals = append(refusals, runtime.Binary+" does not answer: install a rootless podman, or name the runtime binary in runtime.binary")
	case Rootless:
		if host.IsPastaMissing(runtime.Binary) {
			refusals = append(refusals, runtime.Binary+" has no pasta: install passt, which gives a container the trierarch's proxy port and nothing else of the host")
		}
	}
	groups, err := host.Groups()
	if err != nil {
		return nil, err
	}
	if slices.Contains(groups, dockerGroup) {
		refusals = append(refusals, "the user that runs the trierarch is in the docker group, which is root on the machine: take the user out of it")
	}
	for _, name := range configuration.HarnessOrder {
		if !slices.Contains(harnesses, name) && !slices.Contains(notOffered, name) {
			refusals = append(refusals, fmt.Sprintf("%s does not run in a container yet: the container runtime offers %s only, so remove %s", name, strings.Join(harnesses, ", "), name))
		}
	}
	refusals = append(refusals, remoteControl...)
	if !host.IsModelTokenWritten() {
		refusals = append(refusals, "the model token file "+modelToken+" is missing or empty: write the token claude setup-token gives into it, readable by its owner only")
	}
	return refusals, nil
}

// Refusal is the configuration's session runtime refused, with every reason: config check and run both say it so.
func Refusal(configPath string, refusals []string) error {
	lines := []string{"The configuration at " + configPath + " cannot run its sessions in containers:"}
	for _, refusal := range refusals {
		lines = append(lines, "  "+refusal)
	}
	return refusal(strings.Join(lines, "\n"))
}

type refusal string

func (r refusal) Error() string { return string(r) }

// Machine is the machine as it is: how the runtime runs, from the info Podman and docker both give as JSON; the user's groups, from `id`; whether the model token file holds a token; and whether Podman has pasta, from its info.
type Machine struct {
	ModelToken string
}

func (Machine) Mode(binary string) Mode {
	info, err := exec.Command(binary, "info", "--format", "json").Output()
	if err != nil {
		return Missing
	}
	return modeOfInfo(string(info))
}

func (Machine) IsPastaMissing(binary string) bool {
	info, err := exec.Command(binary, "info", "--format", "json").Output()
	return err == nil && isPastaMissingOfInfo(string(info))
}

func (Machine) Groups() ([]string, error) {
	named, err := exec.Command("id", "-Gn").Output()
	if err != nil {
		return nil, fmt.Errorf("id -Gn failed: %w", err)
	}
	return strings.Fields(string(named)), nil
}

func (m Machine) IsModelTokenWritten() bool {
	token, err := os.ReadFile(m.ModelToken)
	return err == nil && strings.TrimSpace(string(token)) != ""
}

// dockerRootless is among docker's security options when its daemon runs rootless.
const dockerRootless = "name=rootless"

// isPastaMissingOfInfo is whether the info is Podman's and names no pasta executable; docker's info says nothing of pasta.
func isPastaMissingOfInfo(info string) bool {
	var said struct {
		Host *struct {
			Security *struct{} `json:"security"`
			Pasta    *struct {
				Executable string `json:"executable"`
			} `json:"pasta"`
		} `json:"host"`
	}
	if json.Unmarshal([]byte(info), &said) != nil || said.Host == nil || said.Host.Security == nil {
		return false
	}
	return said.Host.Pasta == nil || said.Host.Pasta.Executable == ""
}

// modeOfInfo is how the runtime runs, as its info says: Podman's host security, or docker's security options.
func modeOfInfo(info string) Mode {
	var said struct {
		Host *struct {
			Security *struct {
				Rootless *bool `json:"rootless"`
			} `json:"security"`
		} `json:"host"`
		SecurityOptions []string `json:"SecurityOptions"`
	}
	if json.Unmarshal([]byte(info), &said) != nil {
		return Missing
	}
	if said.Host != nil && said.Host.Security != nil && said.Host.Security.Rootless != nil {
		if *said.Host.Security.Rootless {
			return Rootless
		}
		return Rootful
	}
	if said.SecurityOptions != nil {
		if slices.Contains(said.SecurityOptions, dockerRootless) {
			return Rootless
		}
		return Rootful
	}
	return Missing
}
