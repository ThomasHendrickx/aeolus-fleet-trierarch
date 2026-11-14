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
		{"copilot", "Copilot", i.IsCopilotInstalled, i.IsCopilotSignedIn, "npm install -g @github/copilot", "copilot login", "--allow-all-tools"},
	}
}

func positiveCap(text string, fallback int, flag string) (int, error) {
	if text == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(text)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s needs a positive integer", flag)
	}
	return n, nil
}

func askYes(reader *bufio.Reader, terminal io.Writer, question string) (bool, error) {
	for {
		if _, err := fmt.Fprintf(terminal, "%s [y/N] ", question); err != nil {
			return false, err
		}
		answer, err := reader.ReadString('\n')
		if err != nil {
			return false, fmt.Errorf("read terminal answer: %w", err)
		}
		switch strings.ToLower(strings.TrimSpace(answer)) {
		case "y", "yes":
			return true, nil
		case "", "n", "no":
			return false, nil
		default:
			if _, err := fmt.Fprintln(terminal, "Answer yes or no."); err != nil {
				return false, err
			}
		}
	}
}

func (i Init) selectHarnesses(flags Flags) (harnessSelection, error) {
	selection := harnessSelection{harnesses: map[string]config.Harness{}}
	var err error
	selection.caps.Ships, err = positiveCap(flags.MaxShips, 4, "--max-ships")
	if err != nil {
		return selection, err
	}
	selection.caps.Running, err = positiveCap(flags.MaxRunning, 2, "--max-running")
	if err != nil {
		return selection, err
	}
	states := i.harnessStates()
	picked := slices.Clone(flags.Harnesses)
	unattended := slices.Clone(flags.Unattended)
	var terminal io.ReadWriteCloser
	var reader *bufio.Reader
	if (picked == nil || (unattended == nil && !flags.IsYes)) && i.OpenTerminal != nil {
		terminal, err = i.OpenTerminal()
		if err == nil {
			defer terminal.Close()
			reader = bufio.NewReader(terminal)
		}
	}
	if picked == nil {
		if terminal == nil {
			return selection, errors.New("no terminal: init needs --harnesses <claude-code,codex,copilot>; no harness is a default")
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
			yes, err := askYes(reader, terminal, fmt.Sprintf("%s (%s): use this harness?", state.label, status))
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
		if !state.isSignedIn {
			return selection, fmt.Errorf("%s is installed but not signed in: run `%s`, then run the setup line again", state.label, state.login)
		}
	}
	for _, name := range unattended {
		if !slices.Contains(picked, name) {
			return selection, errors.New("--unattended must be a subset of --harnesses")
		}
	}
	if unattended == nil && !flags.IsYes && terminal != nil {
		for _, state := range states {
			if !slices.Contains(picked, state.name) {
				continue
			}
			yes, err := askYes(reader, terminal, state.label+": run without permission questions?")
			if err != nil {
				return selection, err
			}
			if yes {
				unattended = append(unattended, state.name)
			}
		}
	}
	for _, state := range states {
		if !slices.Contains(picked, state.name) {
			continue
		}
		harness := config.Harness{Flags: []string{}, Options: map[string]config.Option{}}
		if slices.Contains(unattended, state.name) {
			harness.Flags = append(harness.Flags, state.unattendedFlag)
		}
		selection.harnesses[state.name] = harness
	}
	return selection, nil
}
