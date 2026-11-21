package shipview

import (
	"context"
	"encoding/json"
	"errors"
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
