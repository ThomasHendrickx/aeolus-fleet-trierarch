// Package logfile is the trierarch's log file capped, by the rule the
// aeolus-fleet plugin's log follows (plugins/aeolus-fleet/README.md, "The
// log"): before a record, a log that reached 1 MiB moves aside as
// `trierarch.log.1`, replacing an older one, and the record starts a new log.
// On macOS launchd writes the log: it opened the file for appending as the
// trierarch's stdout and stderr and keeps it open, so a renamed log would take
// its writes along. The log moves aside as a copy, and the file launchd holds
// is emptied: appending, its next write starts the new log. On Linux the
// journal caps the log itself.
package logfile

import (
	"io"
	"os"
	"time"
)

// Limit is the log's size limit in bytes: the trierarch keeps at most about twice it.
const Limit = 1024 * 1024

// staleLock is the age of a lock left by a writer stopped while moving the log aside.
const staleLock = time.Minute

// Capped writes each record to Out, moving File aside first once it reached
// Limit. A log it cannot move aside is written on: a full disk or a changed
// permission must not stop the trierarch.
type Capped struct {
	File string
	Out  io.Writer
	// Limit is the size limit in bytes; zero is 1 MiB.
	Limit int64
	Now   func() time.Time
}

func (c Capped) Write(record []byte) (int, error) {
	c.moveAsideWhenFull()
	return c.Out.Write(record)
}

func sizeOf(file string) int64 {
	info, err := os.Stat(file)
	if err != nil {
		return 0
	}
	return info.Size()
}

// moveAsideWhenFull moves the log aside once it reached its limit. One writer
// moves it: another finding the lock taken appends on, and the one holding the
// lock looks at the size again, so a log just moved aside by another is not
// moved twice.
func (c Capped) moveAsideWhenFull() {
	limit := c.Limit
	if limit == 0 {
		limit = Limit
	}
	if sizeOf(c.File) < limit {
		return
	}
	lock := c.File + ".lock"
	if taken, err := os.Stat(lock); err == nil && c.Now().Sub(taken.ModTime()) > staleLock {
		_ = os.Remove(lock)
	}
	if os.Mkdir(lock, 0o755) != nil {
		return
	}
	defer os.Remove(lock)
	if sizeOf(c.File) < limit {
		return
	}
	if copyFile(c.File, c.File+".1") == nil {
		_ = os.Truncate(c.File, 0)
	}
}

func copyFile(from string, to string) error {
	source, err := os.Open(from)
	if err != nil {
		return err
	}
	defer source.Close()
	target, err := os.Create(to)
	if err != nil {
		return err
	}
	if _, err := io.Copy(target, source); err != nil {
		target.Close()
		return err
	}
	return target.Close()
}

// IsWritingTo says whether an open file is the log file, as the trierarch's stdout and stderr are under launchd.
func IsWritingTo(open *os.File, file string) bool {
	log, err := os.Stat(file)
	if err != nil {
		return false
	}
	opened, err := open.Stat()
	return err == nil && os.SameFile(opened, log)
}
