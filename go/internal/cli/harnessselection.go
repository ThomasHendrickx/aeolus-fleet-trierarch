package cli

import (
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/keys"
)

type harnessState struct {
	name           string
	label          string
	isInstalled    bool
	isSignedIn     bool
	isKeyStored    bool
	install        string
	login          string
	unattendedFlag string
}

func (i Init) harnessStates() []harnessState {
	return []harnessState{
		{claudeCode, "Claude Code", i.IsClaudeCodeInstalled, i.IsClaudeCodeSignedIn, (keys.Files{Folder: i.Paths.Keys}).Has(claudeCode), "https://code.claude.com/docs/en/setup", "claude auth login", "--dangerously-skip-permissions"},
		{codex, "Codex", i.IsCodexInstalled, i.IsCodexSignedIn, (keys.Files{Folder: i.Paths.Keys}).Has(codex), "npm install -g @openai/codex", "codex login", "--dangerously-bypass-approvals-and-sandbox"},
		{"copilot", "Copilot", i.IsCopilotInstalled, false, false, "npm install -g @github/copilot", "copilot login", "--allow-all-tools"},
	}
}

// maximumCap is the largest integer the shared configuration schema accepts.
const maximumCap = 9007199254740991

func positiveCap(text string, fallback int, flag string) (int, error) {
	if text == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(text)
	if err != nil || n <= 0 || n > maximumCap {
		return 0, fmt.Errorf("%s needs a positive integer no greater than %d", flag, maximumCap)
	}
	return n, nil
}

// permissionCopy explains a harness's permission question before it is asked, as approved for #1243.
var permissionCopy = map[string]string{
	claudeCode: `Claude Code normally uses its own permission controls.
Yes lets its sessions run tools without permission questions, with
this computer user's access. It also accepts Claude Code's bypass
warning for this user. Other Claude Code runs may see that acceptance.
No keeps normal permission controls; work may be refused or wait.`,
	codex: `Codex normally uses its own approvals and sandbox.
Yes bypasses both for sessions started by this trierarch, with this
computer user's access. No keeps normal controls; work may be refused
or wait.`,
}

const copilotCopy = `Copilot's headless sessions always run without tool permission questions.
They use this computer user's access. Pick No to leave Copilot out.`

func (s harnessState) status() string {
	switch {
	case !s.isInstalled:
		return "not installed"
	case s.name == "copilot":
		return "installed; sign-in cannot be checked here"
	case s.isSignedIn:
		return "installed, signed in"
	case s.isKeyStored:
		return "installed, API key stored"
	}
	return "installed, not signed in"
}

func harnessHelp(state harnessState) string {
	text := fmt.Sprintf("Yes lets this trierarch run %s sessions for ships crewed here.\n", state.label)
	switch {
	case state.name == "copilot":
		text += "Copilot must be installed; its sign-in cannot be checked here.\n"
	default:
		text += state.label + " must be installed and signed in or have an API key stored.\n"
	}
	return text + "Pick at least one agent tool. Default: No unless it is the current setting."
}

func permissionHelp(state harnessState) string {
	return permissionCopy[state.name] + "\nDefault: No unless it is the current setting."
}

// fromTheSetupLine is a value a flag answered, shown under its part in place of its question.
func fromTheSetupLine(value string) string {
	return "From the setup line: " + value + "."
}

func labels(states []harnessState, names []string) string {
	var picked []string
	for _, state := range states {
		if slices.Contains(names, state.name) {
			picked = append(picked, state.label)
		}
	}
	if len(picked) == 0 {
		return "none"
	}
	return strings.Join(picked, ", ")
}

// selectHarnesses is part 1: which harnesses run sessions here and whether each runs without permission questions. canAsk is whether a terminal is open to ask on.
func (i Init) selectHarnesses(flags Flags, current config.Configuration, isRerun bool, w wizard, canAsk bool) (map[string]config.Harness, error) {
	states := i.harnessStates()
	picked := slices.Clone(flags.Harnesses)
	unattended := slices.Clone(flags.Unattended)
	w.part(1)
	w.say("An agent tool (a harness) runs the sessions. Pick at least one.")
	if picked == nil {
		if !canAsk {
			return nil, stopped(fmt.Sprintf("No terminal to ask on: init needs %s; no harness is a default.", strings.Join(i.missingInitFlags(flags), ", ")), notJoinedBeforeRegistration, "Add the missing flags, then run your setup line again.")
		}
		if i.IsCursorInstalled {
			w.say("Cursor CLI: not supported yet, cannot be picked.")
		}
		for _, state := range states {
			w.say(state.label + ": " + state.status() + ".")
			if state.name == "copilot" && state.isInstalled {
				w.say(copilotCopy)
			}
			_, isPicked := current.Harnesses[state.name]
			if isRerun {
				w.say(map[bool]string{true: "Current setting: used.", false: "Current setting: not used."}[isPicked])
			}
			yes, err := w.yes("Use "+state.label+"?", harnessHelp(state), isPicked)
			if err != nil {
				return nil, err
			}
			if yes {
				picked = append(picked, state.name)
			}
		}
	} else {
		w.say(fromTheSetupLine(labels(states, picked)))
	}
	if len(picked) == 0 {
		cause := "No agent tool was picked: at least one harness is needed to run sessions."
		if i.IsCursorInstalled {
			cause = "No agent tool was picked: at least one harness is needed to run sessions; Cursor CLI is not supported yet."
		}
		return nil, stopped(cause, "Pick one when setup asks, or name it with --harnesses.", notJoinedBeforeRegistration)
	}
	for _, name := range picked {
		index := slices.IndexFunc(states, func(s harnessState) bool { return s.name == name })
		if index < 0 {
			return nil, stopped(fmt.Sprintf("Harness %q is not supported: use claude-code, codex or copilot.", name), notJoinedBeforeRegistration)
		}
		state := states[index]
		if !state.isInstalled {
			return nil, stopped(state.label+" is not installed.", "Install it with: "+state.install, "Then run your setup line again.", notJoinedBeforeRegistration)
		}
		if state.name != "copilot" && !state.isSignedIn && !state.isKeyStored {
			return nil, stopped(state.label+" is installed but not signed in.", "Run: "+state.login+" or aeolus-trierarch login "+state.name+" --api-key", "Then run your setup line again.", notJoinedBeforeRegistration)
		}
	}
	for _, name := range unattended {
		if !slices.Contains(picked, name) {
			return nil, stopped("--unattended must be a subset of --harnesses.", notJoinedBeforeRegistration)
		}
	}
	isAsked := unattended == nil && !flags.IsYes && canAsk
	if unattended == nil {
		for _, state := range states {
			if !slices.Contains(picked, state.name) || state.name == "copilot" {
				continue
			}
			isUnattended := slices.Contains(current.Harnesses[state.name].Flags, state.unattendedFlag)
			if isAsked {
				w.say("", permissionCopy[state.name])
				if isRerun {
					w.say(map[bool]string{true: "Current setting: yes, without permission questions.", false: "Current setting: no, normal controls."}[isUnattended])
				}
				var err error
				if isUnattended, err = w.yes("Run "+state.label+" without permission questions?", permissionHelp(state), isUnattended); err != nil {
					return nil, err
				}
			}
			if isUnattended {
				unattended = append(unattended, state.name)
			}
		}
	}
	if !isAsked {
		for _, state := range states {
			if !slices.Contains(picked, state.name) || state.name == "copilot" {
				continue
			}
			w.say(fromTheSetupLine(state.label + ": " + permissionMode(state.name, slices.Contains(unattended, state.name))))
		}
	}
	if slices.Contains(picked, "copilot") && flags.Harnesses != nil {
		w.say(copilotCopy)
	}

	harnesses := map[string]config.Harness{}
	for _, state := range states {
		if !slices.Contains(picked, state.name) {
			continue
		}
		harness := config.Harness{Flags: []string{}, Options: map[string]config.Option{}}
		if kept, ok := current.Harnesses[state.name]; ok {
			harness = kept
			harness.Flags = slices.Clone(kept.Flags)
		}
		if state.name != "copilot" {
			if !slices.Contains(unattended, state.name) {
				harness.Flags = slices.DeleteFunc(harness.Flags, func(flag string) bool { return flag == state.unattendedFlag })
			} else if !slices.Contains(harness.Flags, state.unattendedFlag) {
				harness.Flags = append(harness.Flags, state.unattendedFlag)
			}
		}
		if harness.Flags == nil {
			harness.Flags = []string{}
		}
		harnesses[state.name] = harness
	}
	return harnesses, nil
}

// permissionMode is how a harness's sessions meet tool permissions, as the closing summary says it.
func permissionMode(name string, isUnattended bool) string {
	switch {
	case name == "copilot":
		return "runs without tool permission questions"
	case name == codex && isUnattended:
		return "bypasses approvals and sandbox"
	case name == codex:
		return "normal approvals and sandbox"
	case isUnattended:
		return "runs without permission questions"
	}
	return "normal permission controls"
}
