// Package trash is where a ship's clone and its ship's home go when they are removed (docs/trierarch.md, "Session runtime"). A session
// can leave in them what the host user cannot remove, a folder owned by an id its user namespace maps, or one it made read-only. Each is
// first renamed aside, into a trash folder of the trierarch's own beside it: its ship's place is free at once and nothing reads it again.
// Every pass then empties the trash, and what stays in it holds back no release.
package trash

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// FolderName is the trash folder beside what goes in it.
const FolderName = ".trash"

// What the trash holds is named `<name>.<unix milliseconds it was discarded at>`, with a suffix once it could not be removed: its state
// is in its name, so it holds across a restart.
const leftSuffix, toldSuffix = ".left", ".told"

// Discard renames the folder into the trash beside it. Moving a folder to another parent changes its `..`, which needs write on the folder
// itself as well as on both parents, and a session can have made its own top read-only: it is given its owner's read, write and search
// first. One the host cannot give them, or move, is moved within the runtime's user namespace, where the ids a session mapped are its
// own (withinUserNamespace, nil on the host). A link is refused, so nothing it points at is changed.
func Discard(folder string, at time.Time, withinUserNamespace func(from string, to string) error) error {
	found, err := os.Lstat(folder)
	if err != nil {
		return err
	}
	if !found.IsDir() {
		return fmt.Errorf("%s is no folder: the trash takes only a folder", folder)
	}
	trash := filepath.Join(filepath.Dir(folder), FolderName)
	if err := os.Mkdir(trash, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return fmt.Errorf("make the trash %s: %w", trash, err)
	}
	if found, err := os.Lstat(trash); err != nil || !found.IsDir() {
		return fmt.Errorf("the trash %s is no folder", trash)
	}
	to := filepath.Join(trash, filepath.Base(folder)+"."+strconv.FormatInt(at.UnixMilli(), 10))
	err = os.Chmod(folder, found.Mode().Perm()|0o700)
	if err == nil {
		err = os.Rename(folder, to)
	}
	if err == nil || withinUserNamespace == nil {
		return err
	}
	if moved := withinUserNamespace(folder, to); moved != nil {
		return errors.Join(err, moved)
	}
	return nil
}

// Trash empties the trash folders.
type Trash struct {
	// Beside are the folders whose trash it empties, read each pass.
	Beside func() []string
	// Unshare removes a path within the runtime's user namespace, where the ids a session mapped are its own; nil on the host.
	Unshare func(path string) error
}

// Left is what the trash could not remove.
type Left struct {
	// Path is where it is in the trash, and Folder where it was.
	Path   string
	Folder string
	// TrashedAt is when it was discarded.
	TrashedAt time.Time
	// PathHash is a hash of where it was put in the trash, before any state suffix: the same every pass and across a restart, and short.
	PathHash string
	// IsNew is whether this was the first time it could not be removed; IsTold whether argo was told of it.
	IsNew  bool
	IsTold bool
	Why    error
}

// Empty removes what each trash holds: with the host's own removal, then within the runtime's user namespace. It answers what stays.
func (t Trash) Empty() []Left {
	var left []Left
	for _, beside := range t.Beside() {
		trash := filepath.Join(beside, FolderName)
		entries, err := os.ReadDir(trash)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name, trashedAt, state, ok := parse(entry.Name())
			if !ok {
				continue
			}
			path := filepath.Join(trash, entry.Name())
			why := t.remove(path)
			if why == nil {
				continue
			}
			put := sha256.Sum256([]byte(strings.TrimSuffix(path, state)))
			found := Left{Path: path, PathHash: hex.EncodeToString(put[:]), Folder: filepath.Join(beside, name), TrashedAt: trashedAt, IsTold: state == toldSuffix, Why: why}
			if state == "" {
				// Marked left, so it is new only this once.
				if err := os.Rename(path, path+leftSuffix); err != nil {
					found.Why = errors.Join(why, err)
				} else {
					found.Path = path + leftSuffix
				}
				found.IsNew = true
			}
			left = append(left, found)
		}
	}
	return left
}

// MarkTold marks what was left as told to argo.
func (t Trash) MarkTold(path string) error {
	if !strings.HasSuffix(path, leftSuffix) {
		return nil
	}
	return os.Rename(path, strings.TrimSuffix(path, leftSuffix)+toldSuffix)
}

func (t Trash) remove(path string) error {
	err := writableByItsOwner(path)
	if err == nil {
		err = os.RemoveAll(path)
	}
	if err == nil || t.Unshare == nil {
		return err
	}
	if unshared := t.Unshare(path); unshared != nil {
		return errors.Join(err, unshared)
	}
	return nil
}

// parse reads a name in the trash: what it was named, when it was discarded and its state suffix. A name the trash did not give is not
// its own.
func parse(entry string) (string, time.Time, string, bool) {
	state := ""
	for _, suffix := range []string{leftSuffix, toldSuffix} {
		if strings.HasSuffix(entry, suffix) {
			entry, state = strings.TrimSuffix(entry, suffix), suffix
		}
	}
	at := strings.LastIndex(entry, ".")
	if at <= 0 {
		return "", time.Time{}, "", false
	}
	millis, err := strconv.ParseInt(entry[at+1:], 10, 64)
	if err != nil {
		return "", time.Time{}, "", false
	}
	return entry[:at], time.UnixMilli(millis).UTC(), state, true
}

// writableByItsOwner gives each folder in it, its own included, its owner's read, write and search, following no link: a folder a
// session made read-only would keep what it holds from being removed.
func writableByItsOwner(folder string) error {
	// WalkDir calls for a folder before it reads it, and follows no link.
	return filepath.WalkDir(folder, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || !entry.IsDir() {
			return err
		}
		found, err := entry.Info()
		if err != nil {
			return err
		}
		return os.Chmod(path, found.Mode().Perm()|0o700)
	})
}
