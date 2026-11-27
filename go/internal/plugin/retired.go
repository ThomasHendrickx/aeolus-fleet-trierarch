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

func withCacheLock(cache string, flags int, action func() error) error {
	parent := filepath.Dir(cache)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(parent, ".aeolus-fleet-update.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|flags); err != nil {
		if flags == syscall.LOCK_NB && errors.Is(err, syscall.EWOULDBLOCK) {
			return nil
		}
		return err
	}
	return action()
}

// RetiredPath is the backing directory for a retired version's existing cache path.
func RetiredPath(cache, version string) string {
	return filepath.Join(retiredDir(cache), version, "plugin")
}

func retiredDir(cache string) string {
	return filepath.Join(filepath.Dir(cache), ".aeolus-fleet-retired")
}

func retiredLink(cache, version string) string {
	return filepath.Join("..", filepath.Base(retiredDir(cache)), version, "plugin")
}

// IsRetiredLink reports whether the version path points to its retained folder.
func IsRetiredLink(cache, version string) bool {
	link, err := os.Readlink(filepath.Join(cache, version))
	return err == nil && link == retiredLink(cache, version)
}

// ActivateRetired restores a version's directory when Claude Code selects its
// existing cache path again. The caller holds the cache lock.
func ActivateRetired(cache, version string) error {
	if !releaseVersion.MatchString(version) {
		return nil
	}
	path := filepath.Join(cache, version)
	retired := RetiredPath(cache, version)
	if !IsRetiredLink(cache, version) {
		return nil
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	if err := os.Rename(retired, path); err != nil {
		return errors.Join(err, os.Symlink(retiredLink(cache, version), path))
	}
	return os.Remove(filepath.Dir(retired))
}

// RetireNewer keeps newer versions out of selection while preserving their paths
// for sessions that may have loaded them. The caller holds the cache lock.
func RetireNewer(cache, active string, switched time.Time, starts []time.Time) error {
	if !releaseVersion.MatchString(active) {
		return nil
	}
	entries, err := os.ReadDir(cache)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		version := entry.Name()
		if !entry.IsDir() || !releaseVersion.MatchString(version) || slices.Compare(versionParts(version), versionParts(active)) <= 0 {
			continue
		}
		path := filepath.Join(cache, version)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !mayUse(starts, info.ModTime(), switched) {
			if err := os.RemoveAll(path); err != nil {
				return err
			}
			continue
		}
		retired := RetiredPath(cache, version)
		dir := filepath.Dir(retired)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		// A regular cache folder can supersede a retired copy on a later upgrade.
		if err := os.RemoveAll(retired); err != nil {
			return err
		}
		if err := os.Rename(path, retired); err != nil {
			return err
		}
		if err := os.Chtimes(dir, switched, switched); err != nil {
			return errors.Join(err, os.Rename(retired, path))
		}
		if err := os.Symlink(retiredLink(cache, version), path); err != nil {
			return errors.Join(err, os.Rename(retired, path))
		}
	}
	return nil
}

// ReapRetired removes retired versions once no running session can have loaded them.
func ReapRetired(cache string, processStarts func() ([]time.Time, error)) error {
	dir := retiredDir(cache)
	if _, err := os.Stat(dir); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	return withCacheLock(cache, syscall.LOCK_NB, func() error {
		entries, err := os.ReadDir(dir)
		if err != nil || len(entries) == 0 {
			return err
		}
		starts, err := processStarts()
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if !entry.IsDir() || !releaseVersion.MatchString(entry.Name()) {
				continue
			}
			retirement, err := entry.Info()
			if err != nil {
				return err
			}
			target := RetiredPath(cache, entry.Name())
			installed, err := os.Stat(target)
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err != nil {
				return err
			}
			if mayUse(starts, installed.ModTime(), retirement.ModTime()) {
				continue
			}
			path := filepath.Join(cache, entry.Name())
			if IsRetiredLink(cache, entry.Name()) {
				if err := os.Remove(path); err != nil {
					return fmt.Errorf("remove retired plugin path: %w", err)
				}
			}
			if err := os.RemoveAll(filepath.Dir(target)); err != nil {
				return fmt.Errorf("remove retired plugin folder: %w", err)
			}
		}
		return nil
	})
}

// ps reports ages in whole seconds and a starting session takes time to load its plugin.
func mayUse(starts []time.Time, installed, switched time.Time) bool {
	for _, start := range starts {
		if !start.Before(installed.Add(-time.Minute)) && start.Before(switched.Add(time.Minute)) {
			return true
		}
	}
	return false
}
