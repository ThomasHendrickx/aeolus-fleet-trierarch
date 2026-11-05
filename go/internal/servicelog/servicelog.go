// Package servicelog reads the trierarch's log where its service writes it:
// the file the launchd agent writes on macOS (and wherever no service of ours
// runs it), the journal of the systemd user unit on Linux, read through
// `journalctl`.
package servicelog

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/service"
)

// Where is where the log is: its file, or the command that reads the journal.
type Where struct {
	File    string
	Journal string
}

// Log is the trierarch's log as `logs` reads it.
type Log struct {
	Where Where
	// Tail is the last lines lines.
	Tail func(lines int) ([]string, error)
	// Follow writes each line added after it starts, until stop is closed.
	Follow func(stop <-chan struct{}, write func(line string)) error
}

// Run runs a program to its end: what it wrote on stdout and on stderr, and an error when it did not end well.
type Run func(name string, args ...string) (stdout string, stderr string, err error)

// Stream runs a program until it ends or stop is closed, writing each line it prints.
type Stream func(name string, args []string, stop <-chan struct{}, write func(line string)) error

// Of is the log of a machine of that platform: the journal on Linux, the file elsewhere.
func Of(platform string, file string, run Run, stream Stream, every time.Duration) Log {
	if platform != "linux" {
		return Log{
			Where:  Where{File: file},
			Tail:   func(lines int) ([]string, error) { return tailFile(file, lines), nil },
			Follow: func(stop <-chan struct{}, write func(string)) error { return followFile(file, every, stop, write) },
		}
	}
	unit := []string{"--user", "--unit", service.Unit}
	// Each record as the trierarch wrote it, with no journal header or notices.
	plain := []string{"--output", "cat", "--quiet", "--no-pager"}
	return Log{
		Where: Where{Journal: strings.Join(append([]string{"journalctl"}, unit...), " ")},
		Tail: func(lines int) ([]string, error) {
			stdout, stderr, err := run("journalctl", append(append(append([]string{}, unit...), "--lines", strconv.Itoa(lines)), plain...)...)
			if err != nil {
				return nil, fmt.Errorf("journalctl %s failed: %s", strings.Join(unit, " "), strings.TrimSpace(stderr))
			}
			return linesOf(stdout), nil
		},
		Follow: func(stop <-chan struct{}, write func(string)) error {
			return stream("journalctl", append(append(append([]string{}, unit...), "--follow", "--lines", "0"), plain...), stop, write)
		},
	}
}

// linesOf splits text into its lines, without the empty one a final newline leaves.
func linesOf(text string) []string {
	lines := strings.Split(text, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func tailFile(file string, count int) []string {
	text, err := os.ReadFile(file)
	if err != nil {
		return []string{}
	}
	lines := linesOf(string(text))
	if string(text) == "" {
		lines = []string{}
	}
	// As today's trierarch, whose slice(-0) is the whole file.
	if count == 0 {
		return lines
	}
	return lines[max(0, len(lines)-count):]
}

func sizeOf(file string) int64 {
	info, err := os.Stat(file)
	if err != nil {
		return 0
	}
	return info.Size()
}

// followFile writes each whole line added to the file after it starts, checking every interval, until stop is closed.
func followFile(file string, every time.Duration, stop <-chan struct{}, write func(string)) error {
	offset := sizeOf(file)
	partial := ""
	for {
		size := sizeOf(file)
		// A log written anew from the start: follow it from there.
		if size < offset {
			offset, partial = 0, ""
		}
		if size > offset {
			added, err := readFrom(file, offset, size-offset)
			if err == nil {
				offset = size
				lines := strings.Split(partial+added, "\n")
				partial = lines[len(lines)-1]
				for _, line := range lines[:len(lines)-1] {
					select {
					case <-stop:
						return nil
					default:
					}
					write(line)
				}
			}
		}
		select {
		case <-stop:
			return nil
		case <-time.After(every):
		}
	}
}

func readFrom(file string, offset int64, length int64) (string, error) {
	handle, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer handle.Close()
	buffer := make([]byte, length)
	read, err := handle.ReadAt(buffer, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return string(buffer[:read]), nil
}

// RunProgram is Run on this machine's programs.
func RunProgram(name string, args ...string) (string, string, error) {
	command := exec.Command(name, args...)
	var stderr strings.Builder
	command.Stderr = &stderr
	stdout, err := command.Output()
	return string(stdout), stderr.String(), err
}

// StreamProgram is Stream on this machine's programs: its stderr is ours, and stopping it is how a followed program ends, no failure.
func StreamProgram(name string, args []string, stop <-chan struct{}, write func(string)) error {
	command := exec.Command(name, args...)
	command.Stderr = os.Stderr
	out, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return err
	}
	ended := make(chan struct{})
	go func() {
		select {
		case <-stop:
			_ = command.Process.Kill()
		case <-ended:
		}
	}()
	reader := bufio.NewReader(out)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			break
		}
		select {
		case <-stop:
		default:
			write(strings.TrimSuffix(line, "\n"))
		}
	}
	close(ended)
	_ = command.Wait()
	return nil
}
