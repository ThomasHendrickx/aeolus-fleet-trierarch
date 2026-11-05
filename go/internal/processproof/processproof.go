// Package processproof proves what a process is from its command line, so a pid file's pid is signalled only when it is the process the trierarch started: a pid a hold or proxy left behind can belong to any process after the machine boots or the pid is reused.
package processproof

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// Runs is whether the process at pid has the words, one after the other, in its command line. False when the process does not exist, pid is not a process's, or the command line cannot be read.
func Runs(pid int, words ...string) bool {
	if pid <= 1 || len(words) == 0 {
		return false
	}
	line, ok := commandLine(pid)
	if !ok {
		return false
	}
	return strings.Contains(" "+line+" ", " "+strings.Join(words, " ")+" ")
}

// commandLine is the process's arguments joined by spaces: from /proc where it is, from ps elsewhere.
func commandLine(pid int) (string, bool) {
	if text, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline"); err == nil {
		line := strings.TrimSpace(strings.ReplaceAll(strings.TrimRight(string(text), "\x00"), "\x00", " "))
		return line, line != ""
	}
	if _, err := os.Stat("/proc/self"); err == nil {
		return "", false
	}
	text, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	line := strings.TrimSpace(string(text))
	return line, err == nil && line != ""
}
