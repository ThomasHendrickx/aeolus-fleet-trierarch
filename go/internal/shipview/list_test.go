package shipview

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

func TestListReadsShipRowsWithoutSessionContentOrCredentials(t *testing.T) {
	at, now := aView(t)
	writeFact(t, filepath.Join(at.Home, "seen.json"), `{"passAt":"2026-11-20T14:02:27Z","ships":{"shp_one":{"turn":{"state":"busy","since":"2026-11-20T13:31:27Z","seenAt":"2026-11-20T14:02:27Z"},"inbox":{"waiting":2,"forced":1,"seenAt":"2026-11-20T14:02:27Z"}}}}`)
	writeFact(t, filepath.Join(at.Sessions, "shp_one", "events.jsonl"), `{"type":"item.started","item":{"type":"command_execution","command":"private session content"}}`)
	got, err := (Reader{}).List(context.Background(), at, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Ships) != 1 {
		t.Fatalf("List(one ship) = %d rows, want 1", len(got.Ships))
	}
	row := got.Ships[0]
	if row.ShipName != "one" || row.Restarts != 2 || row.Session.Activity == nil || row.Session.Activity.Kind != "tool" {
		t.Fatalf("List(one ship) row = %+v, want one, 2 restarts, tool activity", row)
	}
	if got.PassAt != "2026-11-20T14:02:27Z" {
		t.Fatalf("List(snapshot) pass = %q, want 2026-11-20T14:02:27Z", got.PassAt)
	}
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"SECRET-CREW-TOKEN", "crewToken", "private session content"} {
		if strings.Contains(string(data), forbidden) {
			t.Fatalf("List(one ship) contains %q, want no credentials or session content", forbidden)
		}
	}
}

func TestListReportsUnreadableState(t *testing.T) {
	at, now := aView(t)
	_, err := (Reader{Files: filesOnDisk{denied: at.State}}).List(context.Background(), at, now)
	if !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("List(denied state) = %v, want permission denied", err)
	}
}

func TestListEmptyStateHasNoRows(t *testing.T) {
	at, now := aView(t)
	writeFact(t, at.State, `{"entries":{}}`)
	got, err := (Reader{}).List(context.Background(), at, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Ships) != 0 {
		t.Fatalf("List(empty state) = %d rows, want 0", len(got.Ships))
	}
}

// countedEvents measures the file boundary, so a growing history cannot turn every tick into a full scan.
type countedEvents struct {
	Files
	path  string
	bytes int
}

func (f *countedEvents) Open(path string) (fs.File, error) {
	file, err := f.Files.Open(path)
	if err != nil || path != f.path {
		return file, err
	}
	return countedFile{File: file, owner: f}, nil
}

type countedFile struct {
	fs.File
	owner *countedEvents
}

func (f countedFile) Read(p []byte) (int, error) {
	n, err := f.File.Read(p)
	f.owner.bytes += n
	return n, err
}
func (f countedFile) ReadAt(p []byte, off int64) (int, error) {
	n, err := f.File.(io.ReaderAt).ReadAt(p, off)
	f.owner.bytes += n
	return n, err
}

func TestListReadsOnlyTheTailOfALargeSessionHistory(t *testing.T) {
	at, now := aView(t)
	path := filepath.Join(at.Sessions, "shp_one", "events.jsonl")
	writeFact(t, path, strings.Repeat(`{"type":"thread.started","thread_id":"old"}`+"\n", 30000)+`{"type":"item.completed","item":{"type":"agent_message","text":"latest"}}`+"\n")
	files := &countedEvents{Files: filesOnDisk{}, path: path}
	got, err := (Reader{Files: files}).List(context.Background(), at, now)
	if err != nil {
		t.Fatal(err)
	}
	if got.Ships[0].Session.Activity == nil || got.Ships[0].Session.Activity.Kind != "text" {
		t.Fatalf("List(large history) activity = %+v, want text", got.Ships[0].Session.Activity)
	}
	if files.bytes > 128*1024 {
		t.Fatalf("List(large history) read %d bytes, want <=131072", files.bytes)
	}
}

func TestListReportsWhyActivityCannotBeSafelyMasked(t *testing.T) {
	at, now := aView(t)
	denied := filepath.Join(at.Sessions, "shp_one", "secret-env.json")
	writeFact(t, denied, `{"TOKEN":"fake-secret"}`)
	got, err := (Reader{Files: filesOnDisk{denied: denied}}).List(context.Background(), at, now)
	if err != nil {
		t.Fatal(err)
	}
	for _, failure := range got.Ships[0].Unreadable {
		if failure.Fact == "masking" && failure.Path == denied {
			return
		}
	}
	t.Fatalf("List(unreadable secret) unreadable = %+v, want masking source %s", got.Ships[0].Unreadable, denied)
}

func TestListTailKeepsTheActivityReadersNonemptyLineWindow(t *testing.T) {
	for _, test := range []struct {
		name string
		tail string
		want bool
	}{{"199 later lines", strings.Repeat("not-an-event\n", 199), true}, {"200 later lines", strings.Repeat("not-an-event\n", 200), false}, {"empty lines do not consume the window", strings.Repeat("\n", 100000), true}} {
		t.Run(test.name, func(t *testing.T) {
			at, now := aView(t)
			path := filepath.Join(at.Sessions, "shp_one", "events.jsonl")
			writeFact(t, path, strings.Repeat("old history\n", 10000)+`{"type":"item.completed","item":{"type":"agent_message","text":"latest"}}`+"\n"+test.tail)
			got, err := (Reader{}).List(context.Background(), at, now)
			if err != nil {
				t.Fatal(err)
			}
			if has := got.Ships[0].Session.Activity != nil; has != test.want {
				t.Fatalf("List(%s) activity present = %v, want %v", test.name, has, test.want)
			}
		})
	}
}
