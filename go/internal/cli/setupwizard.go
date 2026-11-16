package cli

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// The wording of the setup wizard is Thomas's approved copy (aeolus-fleet docs/design/computer-setup/after.md, #1243).

const setupIntroduction = `Join this computer to your fleet

The trierarch runs agent sessions on this computer. Each session crews
one ship: an agent you can send work to through the fleet.
Sessions use the tools, files and permissions you allow here.

Setup has four parts:
  1. Agent tools and permissions
  2. Repositories and folders
  3. Ship and session limits
  4. Service and connection

Enter accepts the shown default. Type ? for help at a setup question.
Ctrl+C stops setup. Installed files may remain; see the closing status.`

var setupParts = []string{"Agent tools and permissions", "Repositories and folders", "Ship and session limits", "Service and connection"}

const (
	notJoinedBeforeRegistration = "Not joined: setup stopped before registration."
	runAgainToContinue          = "Run your setup line again when you want to continue."
	filesMayRemain              = "Downloaded files and cloned repositories may remain."
)

// stopped is a stop of setup, its lines the cause, the result and the next action.
func stopped(lines ...string) error {
	return &setupStop{text: strings.Join(lines, "\n")}
}

// setupStop is a stop whose text already says the cause, the result and what to do next.
type setupStop struct{ text string }

func (s *setupStop) Error() string { return s.text }

// stoppedBeforeRegistration is a stop before anything is registered, for a cause that names its own fix.
func stoppedBeforeRegistration(err error) error {
	var stop *setupStop
	if errors.As(err, &stop) {
		return err
	}
	return stopped(err.Error()+".", notJoinedBeforeRegistration)
}

// wizard writes setup's explanations and asks its questions: on the controlling terminal when one is open, otherwise only writing.
type wizard struct {
	reader *bufio.Reader
	out    io.Writer
	// stop is closed when the person stops setup with Ctrl+C.
	stop <-chan struct{}
}

// read is a line read from the terminal, or why none was.
type read struct {
	line string
	err  error
}

func (w wizard) say(lines ...string) {
	for _, line := range lines {
		fmt.Fprintln(w.out, line)
	}
}

func (w wizard) part(number int) {
	w.say("", fmt.Sprintf("Part %d of %d: %s", number, len(setupParts), setupParts[number-1]))
}

// answer asks prompt once and reads the answer; a closed terminal or Ctrl+C stops setup before registration.
func (w wizard) answer(prompt string) (string, error) {
	fmt.Fprint(w.out, prompt)
	reads := make(chan read, 1)
	go func() {
		line, err := w.reader.ReadString('\n')
		reads <- read{line: line, err: err}
	}()
	var line string
	var err error
	select {
	case <-w.stop:
		fmt.Fprintln(w.out)
		return "", stopped("Setup stopped: interrupted by Ctrl+C.", notJoinedBeforeRegistration, runAgainToContinue)
	case got := <-reads:
		line, err = got.line, got.err
	}
	if err != nil {
		fmt.Fprintln(w.out)
		if errors.Is(err, io.EOF) {
			return "", stopped("Setup stopped: the terminal closed before an answer.", notJoinedBeforeRegistration, runAgainToContinue)
		}
		return "", stopped(fmt.Sprintf("Setup stopped: the terminal could not be read: %v.", err), notJoinedBeforeRegistration, runAgainToContinue)
	}
	return strings.TrimSpace(line), nil
}

// ask asks prompt until the answer is no ?: help is shown and the same question asked again.
func (w wizard) ask(prompt string, help string) (string, error) {
	for {
		text, err := w.answer(prompt)
		if err != nil || text != "?" {
			return text, err
		}
		w.say(help)
	}
}

func (w wizard) yes(question string, help string, isDefaultYes bool) (bool, error) {
	choice := "[y/N]"
	if isDefaultYes {
		choice = "[Y/n]"
	}
	for {
		text, err := w.ask(question+" "+choice+" ", help)
		if err != nil {
			return false, err
		}
		switch strings.ToLower(text) {
		case "":
			return isDefaultYes, nil
		case "y", "yes":
			return true, nil
		case "n", "no":
			return false, nil
		}
		w.say("Answer y or n, or ? for help.")
	}
}

func (w wizard) number(question string, help string, fallback int) (int, error) {
	for {
		text, err := w.ask(fmt.Sprintf("%s [%d] ", question, fallback), help)
		if err != nil {
			return 0, err
		}
		if text == "" {
			return fallback, nil
		}
		if n, err := strconv.Atoi(text); err == nil && n > 0 && n <= maximumCap {
			return n, nil
		}
		w.say("Enter a whole number greater than zero, or ? for help.")
	}
}

// shown is a path as a person writes it: under the home folder with ~.
func shown(path string, home string) string {
	if home != "" && path == home {
		return "~"
	}
	if home != "" && strings.HasPrefix(path, home+"/") {
		return "~" + path[len(home):]
	}
	return path
}

// redacted removes each secret given from text, so no recovery text repeats one.
func redacted(text string, secrets ...string) string {
	for _, secret := range secrets {
		if secret != "" {
			text = strings.ReplaceAll(text, secret, "<secret>")
		}
	}
	return text
}
