package logfile

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const mib = 1024 * 1024

const record = `2026-10-11T12:00:00Z aeolus-trierarch runs` + "\n"

var now = time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)

type aLog struct {
	t       *testing.T
	folder  string
	file    string
	written *os.File
}

func newLog(t *testing.T) aLog {
	t.Helper()
	folder := t.TempDir()
	return aLog{t: t, folder: folder, file: filepath.Join(folder, "trierarch.log")}
}

// of fills the log with exactly this many bytes of filler lines.
func (l aLog) of(size int, marker string) string {
	l.t.Helper()
	line := strings.Repeat(marker, 99) + "\n"
	content := strings.Repeat(line, size/len(line)) + strings.Repeat(marker, size%len(line))
	if err := os.WriteFile(l.file, []byte(content), 0o644); err != nil {
		l.t.Fatal(err)
	}
	return content
}

// openedAsLaunchdDoes is the log opened for appending, as launchd opens the agent's StandardOutPath, and kept open.
func (l aLog) openedAsLaunchdDoes() *os.File {
	l.t.Helper()
	file, err := os.OpenFile(l.file, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		l.t.Fatal(err)
	}
	l.t.Cleanup(func() { file.Close() })
	return file
}

// capped writes the trierarch's records to the log through an open file, as its stderr under launchd does.
func (l aLog) capped(limit int64) Capped {
	return Capped{File: l.file, Out: l.openedAsLaunchdDoes(), Limit: limit, Now: func() time.Time { return now }}
}

func (l aLog) read(name string) (string, bool) {
	text, err := os.ReadFile(filepath.Join(l.folder, name))
	return string(text), err == nil
}

func (l aLog) files() []string {
	entries, _ := os.ReadDir(l.folder)
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

func (l aLog) lockedAt(at time.Time) {
	l.t.Helper()
	lock := l.file + ".lock"
	if err := os.Mkdir(lock, 0o755); err != nil {
		l.t.Fatal(err)
	}
	if err := os.Chtimes(lock, at, at); err != nil {
		l.t.Fatal(err)
	}
}

func write(t *testing.T, capped Capped) {
	t.Helper()
	if _, err := capped.Write([]byte(record)); err != nil {
		t.Fatal(err)
	}
}

func TestALogThatReachedItsLimitMovesAsideBeforeTheNextRecordWhichStartsTheNewLogInTheSameOpenFile(t *testing.T) {
	log := newLog(t)
	older := log.of(1000, "x")

	write(t, log.capped(1000))

	if previous, _ := log.read("trierarch.log.1"); previous != older {
		t.Errorf("trierarch.log.1 has %d bytes, want the older log's %d", len(previous), len(older))
	}
	if current, _ := log.read("trierarch.log"); current != record {
		t.Errorf("trierarch.log = %q, want %q", current, record)
	}
}

func TestALogOneByteUnderItsLimitIsAppendedTo(t *testing.T) {
	log := newLog(t)
	older := log.of(999, "x")

	write(t, log.capped(1000))

	if _, isThere := log.read("trierarch.log.1"); isThere {
		t.Error("trierarch.log.1 is there, want none")
	}
	if current, _ := log.read("trierarch.log"); current != older+record {
		t.Errorf("trierarch.log has %d bytes, want %d", len(current), len(older+record))
	}
}

func TestOnePreviousLogIsKeptASecondMoveAsideReplacesTheFirst(t *testing.T) {
	log := newLog(t)
	log.of(1000, "a")
	capped := log.capped(1000)
	write(t, capped)
	second := log.of(1000, "b")

	write(t, capped)

	if previous, _ := log.read("trierarch.log.1"); previous != second {
		t.Errorf("trierarch.log.1 is not the second log")
	}
	if files := log.files(); !slices.Equal(files, []string{"trierarch.log", "trierarch.log.1"}) {
		t.Errorf("the logs are %q, want trierarch.log and trierarch.log.1", files)
	}
}

func TestTheLogIsCappedAt1MiBByDefault(t *testing.T) {
	for _, tt := range []struct {
		name       string
		size       int
		isMoved    bool
		wantLength int
	}{
		{"at 1 MiB it moves aside", mib, true, len(record)},
		{"one byte under 1 MiB it is appended to", mib - 1, false, mib - 1 + len(record)},
	} {
		t.Run(tt.name, func(t *testing.T) {
			log := newLog(t)
			log.of(tt.size, "x")

			write(t, log.capped(0))

			if previous, isThere := log.read("trierarch.log.1"); isThere != tt.isMoved || (tt.isMoved && len(previous) != mib) {
				t.Errorf("trierarch.log.1 is there %v with %d bytes, want there %v", isThere, len(previous), tt.isMoved)
			}
			if current, _ := log.read("trierarch.log"); len(current) != tt.wantLength {
				t.Errorf("trierarch.log has %d bytes, want %d", len(current), tt.wantLength)
			}
		})
	}
}

func TestTheLogIsAppendedToWithoutMovingItAsideWhileAnotherWriterHoldsTheLock(t *testing.T) {
	for _, tt := range []struct {
		name     string
		lockedAt time.Time
	}{
		{"locked now", now},
		{"locked half a minute ago", now.Add(-30 * time.Second)},
	} {
		t.Run(tt.name, func(t *testing.T) {
			log := newLog(t)
			older := log.of(1000, "x")
			log.lockedAt(tt.lockedAt)

			write(t, log.capped(1000))

			if _, isThere := log.read("trierarch.log.1"); isThere {
				t.Error("trierarch.log.1 is there, want none")
			}
			if current, _ := log.read("trierarch.log"); current != older+record {
				t.Errorf("trierarch.log has %d bytes, want %d", len(current), len(older+record))
			}
		})
	}
}

func TestALockOlderThanAMinuteLeftByAWriterStoppedWhileMovingTheLogIsClearedAndTheLogMovesAside(t *testing.T) {
	log := newLog(t)
	older := log.of(1000, "x")
	log.lockedAt(now.Add(-2 * time.Minute))

	write(t, log.capped(1000))

	if previous, _ := log.read("trierarch.log.1"); previous != older {
		t.Errorf("trierarch.log.1 is not the older log")
	}
	if files := log.files(); !slices.Equal(files, []string{"trierarch.log", "trierarch.log.1"}) {
		t.Errorf("the logs are %q, want trierarch.log and trierarch.log.1", files)
	}
}

func TestTheRecordIsWrittenWhereNoLogFileIsYet(t *testing.T) {
	log := newLog(t)
	var written bytes.Buffer

	if _, err := (Capped{File: log.file, Out: &written, Now: func() time.Time { return now }}).Write([]byte(record)); err != nil {
		t.Fatal(err)
	}

	if written.String() != record {
		t.Errorf("wrote %q, want %q", written.String(), record)
	}
	if _, isThere := log.read("trierarch.log.1"); isThere {
		t.Error("trierarch.log.1 is there, want none")
	}
}

func TestIsWritingToSaysWhetherAnOpenFileIsTheLog(t *testing.T) {
	log := newLog(t)
	log.of(0, "x")
	elsewhere, err := os.Create(filepath.Join(log.folder, "elsewhere.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer elsewhere.Close()

	if !IsWritingTo(log.openedAsLaunchdDoes(), log.file) {
		t.Error("IsWritingTo(the log opened as launchd does) = false, want true")
	}
	if IsWritingTo(elsewhere, log.file) {
		t.Error("IsWritingTo(another file) = true, want false")
	}
	if IsWritingTo(elsewhere, filepath.Join(log.folder, "none.log")) {
		t.Error("IsWritingTo(where no log is) = true, want false")
	}
}
