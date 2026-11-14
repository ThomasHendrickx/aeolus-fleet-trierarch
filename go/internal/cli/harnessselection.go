package cli

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
)

// harnessSelection is resolved before init can register anything.
type harnessSelection struct {
	harnesses map[string]config.Harness
	caps      config.Caps
}

type harnessState struct {
	name           string
	label          string
	isInstalled    bool
	isSignedIn     bool
	install        string
	login          string
	unattendedFlag string
}

func (i Init) harnessStates() []harnessState {
	return []harnessState{
		{claudeCode, "Claude Code", i.IsClaudeCodeInstalled, i.IsClaudeCodeSignedIn, "https://code.claude.com/docs/en/setup", "claude auth login", "--dangerously-skip-permissions"},
		{codex, "Codex", i.IsCodexInstalled, i.IsCodexSignedIn, "npm install -g @openai/codex", "codex login", "--dangerously-bypass-approvals-and-sandbox"},
		{"copilot", "Copilot", i.IsCopilotInstalled, false, "npm install -g @github/copilot", "copilot login", "--allow-all-tools"},
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

func askYes(reader *bufio.Reader, terminal io.Writer, question string, isDefaultYes bool) (bool, error) {
	for {
		choice := "[y/N]"
		if isDefaultYes {
			choice = "[Y/n]"
		}
		if _, err := fmt.Fprintf(terminal, "%s %s ", question, choice); err != nil {
			return false, err
		}
		answer, err := reader.ReadString('\n')
		if err != nil {
			return false, fmt.Errorf("read terminal answer: %w", err)
		}
		switch strings.ToLower(strings.TrimSpace(answer)) {
		case "y", "yes":
			return true, nil
		case "":
			return isDefaultYes, nil
		case "n", "no":
			return false, nil
		default:
			if _, err := fmt.Fprintln(terminal, "Answer yes or no."); err != nil {
				return false, err
			}
		}
	}
}

func (i Init) selectHarnesses(flags Flags, current config.Configuration, terminal io.ReadWriteCloser, reader *bufio.Reader) (harnessSelection, error) {
	selection := harnessSelection{harnesses: map[string]config.Harness{}}
	var err error
	selection.caps.Ships, err = positiveCap(flags.MaxShips, current.Caps.Ships, "--max-ships")
	if err != nil {
		return selection, err
	}
	selection.caps.Running, err = positiveCap(flags.MaxRunning, current.Caps.Running, "--max-running")
	if err != nil {
		return selection, err
	}
	states := i.harnessStates()
	picked := slices.Clone(flags.Harnesses)
	unattended := slices.Clone(flags.Unattended)
	if picked == nil {
		if terminal == nil {
			missing := []string{"--harnesses"}
			if !hasRepositoryChoice(flags) && !flags.IsYes {
				missing = append(missing, "--repositories, --repositories-in or --no-repositories")
			}
			if _, err := crew.Read(i.Paths.CrewToken); err != nil {
				for _, flag := range []struct{ name, value string }{{"--fleet-url", flags.FleetURL}, {"--ship-id", flags.ShipID}, {"--secret", flags.Secret}} {
					if flag.value == "" {
						missing = append(missing, flag.name)
					}
				}
			}
			return selection, fmt.Errorf("no terminal: init needs %s; no harness is a default", strings.Join(missing, ", "))
		}
		if i.IsCursorInstalled {
			if _, err := fmt.Fprintln(terminal, "Cursor CLI: not supported yet, cannot be picked."); err != nil {
				return selection, err
			}
		}
		for _, state := range states {
			status := "not installed"
			if state.isInstalled {
				status = "installed, not signed in"
				if state.isSignedIn {
					status = "installed, signed in"
				}
			}
			if state.name == "copilot" && state.isInstalled {
				status = "installed, sign-in cannot be checked"
			}
			_, isPicked := current.Harnesses[state.name]
			yes, err := askYes(reader, terminal, fmt.Sprintf("%s (%s): use this harness?", state.label, status), isPicked)
			if err != nil {
				return selection, err
			}
			if yes {
				picked = append(picked, state.name)
			}
		}
	}
	if len(picked) == 0 {
		reason := "at least one harness is needed"
		if i.IsCursorInstalled {
			reason += "; Cursor CLI is not supported yet"
		}
		return selection, errors.New(reason)
	}
	for _, name := range picked {
		index := slices.IndexFunc(states, func(s harnessState) bool { return s.name == name })
		if index < 0 {
			return selection, fmt.Errorf("harness %q is not supported: use claude-code, codex or copilot", name)
		}
		state := states[index]
		if !state.isInstalled {
			return selection, fmt.Errorf("%s is not installed: install it with %s, then run the setup line again", state.label, state.install)
		}
		if state.name != "copilot" && !state.isSignedIn {
			return selection, fmt.Errorf("%s is installed but not signed in: run `%s`, then run the setup line again", state.label, state.login)
		}
	}
	for _, name := range unattended {
		if !slices.Contains(picked, name) {
			return selection, errors.New("--unattended must be a subset of --harnesses")
		}
	}
	if unattended == nil {
		for _, state := range states {
			if !slices.Contains(picked, state.name) || state.name == "copilot" {
				continue
			}
			isUnattended := slices.Contains(current.Harnesses[state.name].Flags, state.unattendedFlag)
			if !flags.IsYes && terminal != nil {
				isUnattended, err = askYes(reader, terminal, state.label+": run without permission questions?", isUnattended)
				if err != nil {
					return selection, err
				}
			}
			if isUnattended {
				unattended = append(unattended, state.name)
			}
		}
	}

	for _, state := range states {
		if !slices.Contains(picked, state.name) {
			continue
		}
		harness := config.Harness{Flags: []string{}, Options: map[string]config.Option{}}
		if kept, ok := current.Harnesses[state.name]; ok {
			harness = kept
			harness.Flags = slices.Clone(kept.Flags)
		}
		if state.name == "copilot" {
			if terminal != nil {
				if _, err := fmt.Fprintln(terminal, "Copilot always runs without asking, headless."); err != nil {
					return selection, err
				}
			}
		} else {
			isUnattended := slices.Contains(unattended, state.name)
			if !isUnattended {
				harness.Flags = slices.DeleteFunc(harness.Flags, func(flag string) bool { return flag == state.unattendedFlag })
			} else if !slices.Contains(harness.Flags, state.unattendedFlag) {
				harness.Flags = append(harness.Flags, state.unattendedFlag)
			}
		}
		if harness.Flags == nil {
			harness.Flags = []string{}
		}
		selection.harnesses[state.name] = harness
	}
	return selection, nil
}
