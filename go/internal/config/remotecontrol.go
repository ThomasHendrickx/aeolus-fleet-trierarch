package config

import (
	"slices"
	"strings"
)

// RemoteControlFlag is Claude Code's Remote Control flag. A session the trierarch runs has no terminal, so
// no Remote Control: it is refused in a harness's flags, and an upgrade takes it out of the configuration
// (headless H3, H20).
const RemoteControlFlag = "--remote-control"

// isRemoteControl is whether a flag is Remote Control's, with or without a name given with `=`.
func isRemoteControl(flag string) bool {
	return flag == RemoteControlFlag || strings.HasPrefix(flag, RemoteControlFlag+"=")
}

// withoutRemoteControl are the flags without Remote Control's, and the name given after it, a word that is no flag.
func withoutRemoteControl(flags []string) []string {
	kept := []string{}
	for at, flag := range flags {
		if isRemoteControl(flag) || (at > 0 && flags[at-1] == RemoteControlFlag && !strings.HasPrefix(flag, "-")) {
			continue
		}
		kept = append(kept, flag)
	}
	return kept
}

// CarriesRemoteControl is whether the harness launches with Remote Control, in its flags or an option's values.
func (h Harness) CarriesRemoteControl() bool {
	if slices.ContainsFunc(h.Flags, isRemoteControl) {
		return true
	}
	for _, option := range h.Options {
		for _, flags := range option.Values {
			if slices.ContainsFunc(flags, isRemoteControl) {
				return true
			}
		}
	}
	return false
}

// WithoutRemoteControl is the configuration with no Remote Control in any harness's flags or option values,
// and the names of the harnesses it was in, sorted. The configuration it is called on is left as it is.
func (c Configuration) WithoutRemoteControl() (Configuration, []string) {
	var named []string
	harnesses := map[string]Harness{}
	for name, harness := range c.Harnesses {
		if !harness.CarriesRemoteControl() {
			harnesses[name] = harness
			continue
		}
		named = append(named, name)
		options := harness.Options
		if len(options) > 0 {
			options = map[string]Option{}
		}
		for optionName, option := range harness.Options {
			values := map[string][]string{}
			for value, flags := range option.Values {
				values[value] = withoutRemoteControl(flags)
			}
			option.Values = values
			options[optionName] = option
		}
		harnesses[name] = Harness{Flags: withoutRemoteControl(harness.Flags), Options: options}
	}
	if len(named) == 0 {
		return c, nil
	}
	slices.Sort(named)
	c.Harnesses = harnesses
	return c, named
}

// RemoveRemoteControl takes Remote Control out of the configuration at the path, keeping all else it holds:
// the names of the harnesses whose flags carried it, none for a configuration that is missing, does not fit
// or has none. It fails only when it could not write the file.
func RemoveRemoteControl(path string) ([]string, error) {
	configuration, err := Load(path)
	if err != nil {
		return nil, nil
	}
	without, named := configuration.WithoutRemoteControl()
	if len(named) == 0 {
		return nil, nil
	}
	return named, Write(path, without)
}
