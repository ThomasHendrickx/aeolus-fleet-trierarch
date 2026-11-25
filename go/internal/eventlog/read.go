// Package eventlog reads the retained history of a session's event log.
package eventlog

import (
	"bufio"
	"fmt"
	"io/fs"
	"iter"
	"os"
)

// Files is the retained event files, oldest first.
type Files []fs.File

// Open opens a snapshot of the retained files, allowing either file to be absent.
func Open(path string, open func(string) (fs.File, error)) (Files, error) {
	active, err := open(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("open events: %w", err)
		}
		active = nil
	}
	rotated, err := open(path + ".1")
	if os.IsNotExist(err) {
		if active == nil {
			return nil, err
		}
		return Files{active}, nil
	}
	if err != nil {
		Files{active}.Close()
		return nil, fmt.Errorf("open rotated events: %w", err)
	}
	if active == nil {
		return Files{rotated}, nil
	}
	// The hold can rename the active file between these opens.
	activeInfo, err := active.Stat()
	if err != nil {
		Files{rotated, active}.Close()
		return nil, fmt.Errorf("stat active events: %w", err)
	}
	rotatedInfo, err := rotated.Stat()
	if err != nil {
		Files{rotated, active}.Close()
		return nil, fmt.Errorf("stat rotated events: %w", err)
	}
	if os.SameFile(activeInfo, rotatedInfo) {
		_ = rotated.Close()
		return Files{active}, nil
	}
	return Files{rotated, active}, nil
}

// Close closes the files returned by Open.
func (files Files) Close() {
	for _, file := range files {
		if file != nil {
			_ = file.Close()
		}
	}
}

// Lines reads whole lines in order, using a separate scanner for each file.
// The bytes must be consumed before advancing to the next line.
func (files Files) Lines() iter.Seq2[[]byte, error] {
	return func(yield func([]byte, error) bool) {
		for _, file := range files {
			lines := bufio.NewScanner(file)
			lines.Buffer(make([]byte, 64*1024), 64*1024*1024)
			for lines.Scan() {
				if !yield(lines.Bytes(), nil) {
					return
				}
			}
			if err := lines.Err(); err != nil {
				yield(nil, err)
				return
			}
		}
	}
}

// OpenDisk opens the retained files on disk.
func OpenDisk(path string) (Files, error) {
	return Open(path, func(path string) (fs.File, error) { return os.Open(path) })
}
