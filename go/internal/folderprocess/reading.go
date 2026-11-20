package folderprocess

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Process is a process's pid, start time and command, which callers must mask before showing.
type Process struct {
	PID       int
	StartedAt time.Time
	Command   string
}

// In reads the processes whose working folder is in folder, including whole commands.
func In(ctx context.Context, folder string, now time.Time) ([]Process, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if real, err := filepath.EvalSymlinks(folder); err == nil {
		folder = real
	}
	wanted := map[int]bool{}
	for _, each := range ProcessFolders() {
		if IsInside(each.Path, folder) {
			wanted[each.PID] = true
		}
	}
	found := []Process{}
	if len(wanted) == 0 {
		return found, nil
	}
	pids := make([]int, 0, len(wanted))
	for pid := range wanted {
		pids = append(pids, pid)
	}
	slices.Sort(pids)
	names := make([]string, 0, len(pids))
	for _, pid := range pids {
		names = append(names, strconv.Itoa(pid))
	}
	text, err := exec.CommandContext(ctx, "ps", "-ww", "-p", strings.Join(names, ","), "-o", "pid=,etime=,args=").Output()
	if err != nil {
		return nil, fmt.Errorf("read process times: %w", err)
	}
	times, err := Commands(string(text), now)
	if err != nil {
		return nil, err
	}
	for _, each := range times {
		if wanted[each.PID] {
			found = append(found, each)
		}
	}
	return found, nil
}

// Times reads ps's pid and elapsed time columns, refusing any unexpected column.
func Times(text string, now time.Time) ([]Process, error) {
	found := []Process{}
	for _, line := range strings.Split(text, "\n") {
		columns := strings.Fields(line)
		if len(columns) == 0 || columns[0] == "PID" {
			continue
		}
		if len(columns) != 2 {
			return nil, errors.New("invalid process time columns")
		}
		pid, err := strconv.Atoi(columns[0])
		if err != nil || pid <= 0 {
			return nil, errors.New("invalid process pid")
		}
		elapsed, err := duration(columns[1])
		if err != nil {
			return nil, err
		}
		found = append(found, Process{PID: pid, StartedAt: now.Add(-elapsed)})
	}
	return found, nil
}

// Commands reads ps's pid, elapsed time and remaining command, preserving its spaces.
func Commands(text string, now time.Time) ([]Process, error) {
	found := []Process{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		pidText, rest := column(line)
		if pidText == "PID" {
			continue
		}
		elapsedText, command := column(rest)
		pid, err := strconv.Atoi(pidText)
		if err != nil || pid <= 0 {
			return nil, errors.New("invalid process pid")
		}
		elapsed, err := duration(elapsedText)
		if err != nil {
			return nil, err
		}
		if command == "" {
			return nil, errors.New("missing process command")
		}
		found = append(found, Process{PID: pid, StartedAt: now.Add(-elapsed), Command: command})
	}
	return found, nil
}

func column(text string) (string, string) {
	at := strings.IndexAny(text, " \t")
	if at < 0 {
		return text, ""
	}
	return text[:at], strings.TrimLeft(text[at:], " \t")
}

func duration(text string) (time.Duration, error) {
	invalid := errors.New("invalid process elapsed time")
	days := 0
	if before, after, ok := strings.Cut(text, "-"); ok {
		n, err := strconv.Atoi(before)
		if err != nil || n < 0 {
			return 0, invalid
		}
		days = n
		text = after
	}
	parts := strings.Split(text, ":")
	if len(parts) < 2 || len(parts) > 3 {
		return 0, invalid
	}
	total := time.Duration(0)
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 || (i > 0 && n >= 60) {
			return 0, invalid
		}
		total = total*60 + time.Duration(n)*time.Second
	}
	return time.Duration(days)*24*time.Hour + total, nil
}
