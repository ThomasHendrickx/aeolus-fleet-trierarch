package cli

import (
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/claudecode"
	codexharness "github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/codex"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/commandline"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/copilot"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/prompt"
)

// firstPrompt is what the settings' first prompt stands for where config check shows a command line.
const firstPrompt = "<first prompt>"

// launched is what a harness's adapter adds itself and launches with some flags, on a first start and a restart.
type launched struct {
	adapterFlags []commandline.AdapterFlag
	commandLines func(flags []string) (firstStart []commandline.Part, restart []commandline.Part)
}

// adapters are the harnesses this trierarch has an adapter for.
var adapters = map[string]launched{
	"claude-code": {claudecode.AdapterFlags, func(flags []string) ([]commandline.Part, []commandline.Part) {
		return claudecode.CommandParts(flags, false), claudecode.CommandParts(flags, true)
	}},
	"codex": {codexharness.AdapterFlags, func(flags []string) ([]commandline.Part, []commandline.Part) {
		return codexharness.CommandParts(flags, prompt.First(firstPrompt), true), codexharness.CommandParts(flags, prompt.Wake(codexharness.WakeCommand), false)
	}},
	"copilot": {copilot.AdapterFlags, func(flags []string) ([]commandline.Part, []commandline.Part) {
		// A restart resumes the session its last turn named, which config check cannot know: it shows the restart without it.
		return copilot.CommandParts(flags, prompt.First(firstPrompt), ""), copilot.CommandParts(flags, prompt.Wake(copilot.WakePrompt), "")
	}},
}

// harnessCheck is what config check says of a harness: the flags settings with no options launch with, each option value's flags, the flags the adapter adds itself, and the command lines of a first start and a restart.
type harnessCheck struct {
	Flags        []string                       `json:"flags"`
	Options      map[string]map[string][]string `json:"options"`
	AdapterFlags []commandline.AdapterFlag      `json:"adapterFlags"`
	FirstStart   []commandline.Part             `json:"firstStart,omitempty"`
	Restart      []commandline.Part             `json:"restart,omitempty"`
}

// runtimeLine says where the sessions run, in a line.
func runtimeLine(runtime config.Runtime, modelToken string) string {
	if runtime.Kind != "container" {
		return "Sessions run on the host."
	}
	return fmt.Sprintf("Sessions run in containers of %s, each capped at %s of memory and %s cpus, with the model token in %s.", runtime.Binary, runtime.Memory, strconv.FormatFloat(runtime.Cpus, 'f', -1, 64), modelToken)
}

// describeFlags is what config check prints per harness: the flags settings with no options launch with, and each option's values.
func describeFlags(configuration config.Configuration) string {
	lines := []string{}
	for _, name := range slices.Sorted(maps.Keys(configuration.Harnesses)) {
		harness := configuration.Harnesses[name]
		lines = append(lines, name+": "+orNoFlags(harness.EffectiveFlags(nil)))
		for _, optionName := range harness.OptionNames() {
			option := harness.Options[optionName]
			for _, value := range option.Names() {
				isDefault := ""
				if option.Default == value {
					isDefault = " (default)"
				}
				lines = append(lines, fmt.Sprintf("  %s=%s%s: %s", optionName, value, isDefault, orNoFlags(option.Values[value])))
			}
		}
	}
	return strings.Join(lines, "\n")
}

func orNoFlags(flags []string) string {
	if len(flags) == 0 {
		return "(no flags)"
	}
	return strings.Join(flags, " ")
}

// configCheck checks the configuration and says how the sessions run, the flags per harness with the detected options as a running trierarch has them, and what each harness launches with the default options.
func configCheck(at paths.Paths) (answer, error) {
	loaded, err := config.Load(at.Config)
	if err != nil {
		return answer{}, err
	}
	if ignored := detection.ModelOptionsIgnored(loaded); len(ignored) > 0 {
		return answer{}, refused(nil, "The configuration at %s sets a model option for %s: model ids come from detection only (#382), so remove it; aeolus-trierarch detect lists them", at.Config, strings.Join(ignored, ", "))
	}
	runtime := config.Runtime{Kind: "host"}
	if loaded.Runtime != nil {
		runtime = *loaded.Runtime
	}
	// The detected options too (#365), as the running trierarch has them.
	configuration := detection.Offered(loaded, (detection.File{Path: at.Detected}).Load())
	names := slices.Sorted(maps.Keys(configuration.Harnesses))
	checks := map[string]harnessCheck{}
	commands := []string{}
	for _, name := range names {
		harness := configuration.Harnesses[name]
		flags := harness.EffectiveFlags(nil)
		options := map[string]map[string][]string{}
		for optionName, option := range harness.Options {
			values := map[string][]string{}
			for value, valueFlags := range option.Values {
				values[value] = append([]string{}, valueFlags...)
			}
			options[optionName] = values
		}
		check := harnessCheck{Flags: flags, Options: options, AdapterFlags: []commandline.AdapterFlag{}}
		adapter, ok := adapters[name]
		if !ok {
			commands = append(commands, name+": this trierarch has no adapter for it")
			checks[name] = check
			continue
		}
		check.AdapterFlags = adapter.adapterFlags
		check.FirstStart, check.Restart = adapter.commandLines(flags)
		checks[name] = check
		commands = append(commands, name+":", "  first start: "+commandline.Describe(check.FirstStart), "  restart: "+commandline.Describe(check.Restart))
	}
	text := append([]string{
		fmt.Sprintf("The configuration at %s fits.", at.Config),
		runtimeLine(runtime, at.ModelToken),
		"Flags per harness (settings pick option values by name):",
		describeFlags(configuration),
		"",
		"What each harness launches, with the default options:",
	}, commands...)
	return answer{data: map[string]any{"path": at.Config, "harnesses": checks, "runtime": runtime}, text: strings.Join(text, "\n")}, nil
}
