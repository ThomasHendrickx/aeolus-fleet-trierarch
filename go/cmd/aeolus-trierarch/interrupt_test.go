package main

import (
	"bytes"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// TestMain runs the trierarch itself when a test starts this test binary as the program.
func TestMain(m *testing.M) {
	if arguments, ok := os.LookupEnv("AEOLUS_TRIERARCH_TEST_RUN_MAIN"); ok {
		os.Args = append([]string{"aeolus-trierarch"}, strings.Fields(arguments)...)
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestCtrlCAtASetupQuestionStopsSetupAndSaysItsClosingState(t *testing.T) {
	controller, terminalPath, err := openPseudoTerminal()
	if err != nil {
		t.Skipf("no pseudo-terminal: %v", err)
	}
	defer controller.Close()
	terminal, err := os.OpenFile(terminalPath, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer terminal.Close()
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	// Only an ss stand-in on PATH: Linux setup needs ss, and no harness is found.
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "ss"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(program)
	command.Env = []string{"AEOLUS_TRIERARCH_TEST_RUN_MAIN=init", "HOME=" + home, "PATH=" + bin}
	command.Stdin, command.Stdout, command.Stderr = terminal, terminal, terminal
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- command.Wait() }()
	t.Cleanup(func() { command.Process.Kill() })
	terminal.Close()

	var shown screen
	read := make(chan struct{}, 1)
	go func() {
		chunk := make([]byte, 4096)
		for {
			n, err := controller.Read(chunk)
			if n > 0 {
				shown.write(chunk[:n])
				select {
				case read <- struct{}{}:
				default:
				}
			}
			if err != nil {
				return
			}
		}
	}()
	waitFor := func(text string) {
		deadline := time.After(10 * time.Second)
		for !strings.Contains(shown.text(), text) {
			select {
			case <-read:
			case <-time.After(50 * time.Millisecond):
			case <-deadline:
				t.Fatalf("setup never showed %q; it showed:\n%s", text, shown.text())
			}
		}
	}
	waitFor("Use Claude Code? [y/N] ")

	if _, err := io.WriteString(controller, "\x03"); err != nil {
		t.Fatal(err)
	}

	select {
	case <-exited:
	case <-time.After(10 * time.Second):
		t.Fatalf("setup went on after Ctrl+C; it showed:\n%s", shown.text())
	}
	waitFor("Setup stopped: interrupted by Ctrl+C.\r\nNot joined: setup stopped before registration.\r\nRun your setup line again when you want to continue.")
}

// screen is what a terminal showed, read while the process still writes it.
type screen struct {
	mutex sync.Mutex
	shown bytes.Buffer
}

func (s *screen) write(chunk []byte) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.shown.Write(chunk)
}

func (s *screen) text() string {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.shown.String()
}
