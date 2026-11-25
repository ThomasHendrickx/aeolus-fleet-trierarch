package hold

import (
	"errors"
	"fmt"
	"os"
	"sync"
)

const eventLogLimit = 10_000_000

// eventLog keeps each line whole and serializes rotation with stdout and stderr writes.
type eventLog struct {
	mutex    sync.Mutex
	path     string
	file     *os.File
	size     int64
	isClosed bool
}

func openEventLog(path string) (*eventLog, error) {
	log := &eventLog{path: path}
	if err := log.open(); err != nil {
		return nil, err
	}
	return log, nil
}

func (l *eventLog) open() error {
	file, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open events: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return fmt.Errorf("stat events: %w", err)
	}
	l.file = file
	l.size = info.Size()
	return nil
}

func (l *eventLog) appendLine(line string) error {
	l.mutex.Lock()
	defer l.mutex.Unlock()

	if l.isClosed {
		return fmt.Errorf("append to %s: %w", l.path, os.ErrClosed)
	}

	var rotationErr error
	if l.file != nil && l.size >= eventLogLimit {
		rotationErr = os.Rename(l.path, l.path+".1")
		if rotationErr == nil {
			_ = l.file.Close()
			l.file = nil
		} else {
			rotationErr = fmt.Errorf("rotate events: %w", rotationErr)
		}
	}
	if l.file == nil {
		if err := l.open(); err != nil {
			return err
		}
	}
	n, err := l.file.WriteString(line + "\n")
	l.size += int64(n)
	if err != nil {
		err = fmt.Errorf("write events: %w", err)
	}
	return errors.Join(rotationErr, err)
}

func (l *eventLog) close() {
	l.mutex.Lock()
	defer l.mutex.Unlock()
	l.isClosed = true
	if l.file != nil {
		_ = l.file.Close()
	}
}
