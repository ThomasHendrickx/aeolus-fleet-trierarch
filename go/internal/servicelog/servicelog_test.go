package servicelog

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const unit = "--user --unit aeolus-trierarch.service"

type aJournal struct {
	stdout   string
	err      error
	calls    []string
	streamed []string
}

func (j *aJournal) run(name string, args ...string) (string, string, error) {
	j.calls = append(j.calls, name+" "+strings.Join(args, " "))
	return j.stdout, "No journal files were found.", j.err
}

func (j *aJournal) stream(name string, args []string, stop <-chan struct{}, write func(string)) error {
	j.streamed = append(j.streamed, name+" "+strings.Join(args, " "))
	write("a new line")
	<-stop
	return nil
}

func TestOnLinuxTheJournalOfTheUnitIsReadWithNoHeader(t *testing.T) {
	journal := &aJournal{stdout: "one\ntwo\n"}
	log := Of("linux", "/logs/trierarch.log", journal.run, journal.stream, time.Millisecond)

	lines, err := log.Tail(2)

	want := "journalctl " + unit + " --lines 2 --output cat --quiet --no-pager"
	if err != nil || !reflect.DeepEqual(lines, []string{"one", "two"}) || !reflect.DeepEqual(journal.calls, []string{want}) {
		t.Fatalf("read %q, %v by %q", lines, err, journal.calls)
	}
	if log.Where.Journal != "journalctl "+unit || log.Where.File != "" {
		t.Errorf("where %+v", log.Where)
	}
}

func TestAJournalThatFailsSaysWhy(t *testing.T) {
	journal := &aJournal{err: errors.New("exit status 1")}
	log := Of("linux", "", journal.run, journal.stream, time.Millisecond)

	_, err := log.Tail(5)

	if err == nil || err.Error() != "journalctl "+unit+" failed: No journal files were found." {
		t.Errorf("said %v", err)
	}
}

func TestFollowingTheJournalStartsAfterItsLastLineAndEndsWhenStopped(t *testing.T) {
	journal := &aJournal{}
	log := Of("linux", "", journal.run, journal.stream, time.Millisecond)
	stop := make(chan struct{})
	var written []string

	go func() {
		time.Sleep(20 * time.Millisecond)
		close(stop)
	}()
	err := log.Follow(stop, func(line string) { written = append(written, line) })

	want := "journalctl " + unit + " --follow --lines 0 --output cat --quiet --no-pager"
	if err != nil || !reflect.DeepEqual(written, []string{"a new line"}) || !reflect.DeepEqual(journal.streamed, []string{want}) {
		t.Errorf("wrote %q, %v by %q", written, err, journal.streamed)
	}
}

func TestElsewhereTheLogIsTheFileTheServiceWrites(t *testing.T) {
	file := filepath.Join(t.TempDir(), "trierarch.log")
	log := Of("darwin", file, nil, nil, time.Millisecond)
	if lines, err := log.Tail(3); err != nil || len(lines) != 0 {
		t.Fatalf("a log not written yet read %q, %v", lines, err)
	}
	if err := os.WriteFile(file, []byte("one\ntwo\nthree\nfour\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	last, _ := log.Tail(2)
	more, _ := log.Tail(9)

	if log.Where.File != file || !reflect.DeepEqual(last, []string{"three", "four"}) || len(more) != 4 {
		t.Errorf("read %q, %q from %+v", last, more, log.Where)
	}
}

func TestZeroLinesOfTheFileIsTheWholeFileAsTodaysTrierarchReadsIt(t *testing.T) {
	file := filepath.Join(t.TempDir(), "trierarch.log")
	log := Of("darwin", file, nil, nil, time.Millisecond)
	if err := os.WriteFile(file, []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	all, _ := log.Tail(0)

	if !reflect.DeepEqual(all, []string{"one", "two"}) {
		t.Errorf("--lines 0 read %q", all)
	}
}

func TestFollowingTheFileWritesEachWholeLineAddedAfterAndFollowsALogWrittenAnew(t *testing.T) {
	file := filepath.Join(t.TempDir(), "trierarch.log")
	if err := os.WriteFile(file, []byte("before\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	log := Of("darwin", file, nil, nil, time.Millisecond)
	stop := make(chan struct{})
	lines := make(chan string, 10)
	done := make(chan error)
	go func() { done <- log.Follow(stop, func(line string) { lines <- line }) }()
	// It follows what is written after it starts: give it the moment to start.
	time.Sleep(100 * time.Millisecond)

	appendTo := func(text string) {
		handle, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			t.Fatal(err)
		}
		defer handle.Close()
		_, _ = handle.WriteString(text)
	}
	next := func() string {
		select {
		case line := <-lines:
			return line
		case <-time.After(5 * time.Second):
			t.Fatal("no line followed")
			return ""
		}
	}
	appendTo("first\nsec")
	if got := next(); got != "first" {
		t.Errorf("followed %q", got)
	}
	appendTo("ond\n")
	if got := next(); got != "second" {
		t.Errorf("followed %q", got)
	}
	if err := os.WriteFile(file, []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := next(); got != "new" {
		t.Errorf("followed %q after the log was written anew", got)
	}
	close(stop)
	if err := <-done; err != nil {
		t.Error(err)
	}
}
