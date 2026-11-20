package container

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestAContainersProcessesShowPIDStartAndWholeCommand(t *testing.T) {
	now := time.Date(2026, 11, 20, 14, 2, 31, 0, time.UTC)
	runtime := Runtime{Run: func(args ...string) (string, error) {
		want := []string{"top", "trierarch-shp_one", "-eo", "pid,etime,args"}
		if !reflect.DeepEqual(args, want) {
			t.Fatalf("runtime arguments = %v, want %v", args, want)
		}
		return "PID ELAPSED COMMAND\n48211 31:03 npm test --workspaces\n", nil
	}}
	got, err := runtime.Processes(context.Background(), "shp_one", now)
	if err != nil || len(got) != 1 || got[0].PID != 48211 || got[0].StartedAt.Format(time.RFC3339) != "2026-11-20T13:31:28Z" || got[0].Command != "npm test --workspaces" {
		t.Fatalf("Processes = %+v, %v", got, err)
	}
}

func TestAnUnreadableContainerProcessListReturnsItsError(t *testing.T) {
	unavailable := errors.New("runtime unavailable")
	runtime := Runtime{Run: func(...string) (string, error) { return "", unavailable }}
	_, err := runtime.Processes(context.Background(), "shp_one", time.Now())
	if !errors.Is(err, unavailable) {
		t.Fatalf("Processes = %v, want unavailable", err)
	}
}
