package plugin

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"syscall"
	"time"
)

// WithCacheLock serializes plugin updates and cleanup for this harness.
func WithCacheLock(cache string, action func() error) error {
	return withCacheLock(cache, 0, action)
}

// TryWithCacheLock skips cleanup when a plugin update already holds the cache lock.
func TryWithCacheLock(cache string, action func() error) error {
	return withCacheLock(cache, syscall.LOCK_NB, action)
}

func withCacheLock(cache string, flags int, action func() error) error {
	parent := filepath.Dir(cache)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return fmt.Errorf("create plugin cache parent %s: %w", parent, err)
	}
	lock, err := os.OpenFile(filepath.Join(parent, ".aeolus-fleet-update.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("open plugin cache lock for %s: %w", cache, err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|flags); err != nil {
		if flags == syscall.LOCK_NB && errors.Is(err, syscall.EWOULDBLOCK) {
			return nil
		}
		return fmt.Errorf("take plugin cache lock for %s: %w", cache, err)
	}
	return action()
}

// KeptVersionPath is the backing directory for a kept version's existing cache path.
func KeptVersionPath(cache, version string) string {
	return filepath.Join(keptVersionsDir(cache), version, "plugin")
}

func keptVersionsDir(cache string) string {
	return filepath.Join(filepath.Dir(cache), ".aeolus-fleet-kept-versions")
}

func keptVersionLink(cache, version string) string {
	return filepath.Join("..", filepath.Base(keptVersionsDir(cache)), version, "plugin")
}

// IsKeptVersionLink reports whether the version path points to its retained folder.
func IsKeptVersionLink(cache, version string) bool {
	link, err := os.Readlink(filepath.Join(cache, version))
	return err == nil && link == keptVersionLink(cache, version)
}

// KeepNewerVersions keeps newer versions out of selection while preserving their paths
// for sessions that may have loaded them. The caller holds the cache lock.
func KeepNewerVersions(cache, active string, switched time.Time, starts []time.Time) error {
	if !releaseVersion.MatchString(active) {
		return nil
	}
	entries, err := os.ReadDir(cache)
	if err != nil {
		return fmt.Errorf("list plugin versions in %s: %w", cache, err)
	}
	for _, entry := range entries {
		version := entry.Name()
		if !entry.IsDir() || !releaseVersion.MatchString(version) || slices.Compare(versionParts(version), versionParts(active)) <= 0 {
			continue
		}
		path := filepath.Join(cache, version)
		info, err := entry.Info()
		if err != nil {
			return fmt.Errorf("read plugin version %s: %w", path, err)
		}
		if !mayUse(starts, info.ModTime(), switched) {
			if err := os.RemoveAll(path); err != nil {
				return fmt.Errorf("remove unused plugin version %s: %w", path, err)
			}
			continue
		}
		kept := KeptVersionPath(cache, version)
		dir := filepath.Dir(kept)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("create kept plugin directory %s: %w", dir, err)
		}
		// A regular cache folder can supersede a kept copy on a later upgrade.
		if err := os.RemoveAll(kept); err != nil {
			return fmt.Errorf("remove superseded plugin directory %s: %w", kept, err)
		}
		if err := os.Rename(path, kept); err != nil {
			return fmt.Errorf("move plugin version %s to %s: %w", path, kept, err)
		}
		if err := os.Chtimes(dir, switched, switched); err != nil {
			return errors.Join(fmt.Errorf("keep plugin version %s: %w", path, err), os.Rename(kept, path))
		}
		if err := os.Symlink(keptVersionLink(cache, version), path); err != nil {
			return errors.Join(fmt.Errorf("keep plugin version %s: %w", path, err), os.Rename(kept, path))
		}
	}
	return nil
}

// RemoveUnusedVersions removes kept versions once no running session can have loaded them.
func RemoveUnusedVersions(cache string, processStarts func() ([]time.Time, error)) error {
	dir := keptVersionsDir(cache)
	if _, err := os.Stat(dir); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("check kept plugin directory %s: %w", dir, err)
	}
	return TryWithCacheLock(cache, func() error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return fmt.Errorf("list kept plugin versions in %s: %w", dir, err)
		}
		if len(entries) == 0 {
			return nil
		}
		starts, err := processStarts()
		if err != nil {
			return fmt.Errorf("list running plugin sessions: %w", err)
		}
		for _, entry := range entries {
			if !entry.IsDir() || !releaseVersion.MatchString(entry.Name()) {
				continue
			}
			keptAt, err := entry.Info()
			if err != nil {
				return fmt.Errorf("read kept plugin version %s: %w", entry.Name(), err)
			}
			target := KeptVersionPath(cache, entry.Name())
			installed, err := os.Stat(target)
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err != nil {
				return fmt.Errorf("check kept plugin directory %s: %w", target, err)
			}
			if mayUse(starts, installed.ModTime(), keptAt.ModTime()) {
				continue
			}
			path := filepath.Join(cache, entry.Name())
			if IsKeptVersionLink(cache, entry.Name()) {
				if err := os.Remove(path); err != nil {
					return fmt.Errorf("remove kept plugin path: %w", err)
				}
			}
			if err := os.RemoveAll(filepath.Dir(target)); err != nil {
				return fmt.Errorf("remove kept plugin folder: %w", err)
			}
		}
		return nil
	})
}

// mayUse allows for process ages rounded to seconds and time spent loading the plugin.
func mayUse(starts []time.Time, installed, switched time.Time) bool {
	for _, start := range starts {
		if !start.Before(installed.Add(-time.Minute)) && start.Before(switched.Add(time.Minute)) {
			return true
		}
	}
	return false
}
