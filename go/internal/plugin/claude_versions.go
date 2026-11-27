package plugin

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"syscall"
	"time"
)

// RemoveUnusedClaudeVersions removes unregistered newer versions that running
// sessions cannot still use. Claude Code selects from its registry, so a
// directory can stay at its original path while it is in use. The caller holds
// the cache lock.
func RemoveUnusedClaudeVersions(plugins, cache string, processStarts func() ([]time.Time, error)) error {
	installs, err := claudeInstalls(plugins)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	root := claudeUserInstall(installs)
	active := filepath.Base(root)
	if filepath.Dir(root) != cache || !releaseVersion.MatchString(active) {
		return nil
	}
	entries, err := os.ReadDir(cache)
	if err != nil {
		return fmt.Errorf("list claude code plugin versions in %s: %w", cache, err)
	}
	var candidates []string
	for _, entry := range entries {
		version := entry.Name()
		if !entry.IsDir() || !releaseVersion.MatchString(version) || slices.Compare(versionParts(version), versionParts(active)) <= 0 {
			continue
		}
		path := filepath.Join(cache, version)
		if !slices.ContainsFunc(installs, func(install claudeInstall) bool { return filepath.Clean(install.Path) == path }) {
			candidates = append(candidates, path)
		}
	}
	if len(candidates) == 0 {
		return nil
	}
	starts, err := processStarts()
	if err != nil {
		return fmt.Errorf("list sessions before cleaning the claude code plugin cache: %w", err)
	}
	for _, path := range candidates {
		inUse, err := claudeVersionInUse(path, starts)
		if err != nil {
			return fmt.Errorf("check use of claude code plugin version %s: %w", path, err)
		}
		if !inUse {
			if err := os.RemoveAll(path); err != nil {
				return fmt.Errorf("remove unused claude code plugin version %s: %w", path, err)
			}
		}
	}
	return nil
}

func claudeVersionInUse(path string, starts []time.Time) (bool, error) {
	markers, err := os.ReadDir(filepath.Join(path, ".in_use"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("list claude code plugin usage markers: %w", err)
	}
	for _, marker := range markers {
		pid, err := strconv.ParseInt(marker.Name(), 10, 32)
		if err == nil && pid > 0 && !errors.Is(syscall.Kill(int(pid), 0), syscall.ESRCH) {
			return true, nil
		}
	}
	// Claude Code writes this marker when it switches away. The version
	// directory's mtime changes too, so it cannot bound when use began.
	orphaned, err := os.Stat(filepath.Join(path, ".orphaned_at"))
	if errors.Is(err, os.ErrNotExist) {
		return len(starts) > 0, nil
	}
	if err != nil {
		return false, fmt.Errorf("read claude code plugin switch time: %w", err)
	}
	return mayUse(starts, time.Time{}, orphaned.ModTime()), nil
}
