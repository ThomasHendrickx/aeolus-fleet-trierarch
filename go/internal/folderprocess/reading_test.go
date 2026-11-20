package folderprocess

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestProcessesInAFolderShowTheirPIDStartAndCommand(t *testing.T) {
	folder := aFolder(t)
	child, _ := aProcessIn(t, folder, "sleep", "30")
	_, _ = aProcessIn(t, aFolder(t), "sleep", "30")
	now := time.Date(2026, 11, 20, 14, 2, 31, 0, time.UTC)
	found, err := In(context.Background(), folder, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 1 || found[0].PID != child.Process.Pid || found[0].StartedAt.After(now) || found[0].StartedAt.Before(now.Add(-5*time.Second)) {
		t.Fatalf("In(%s) = %+v, want pid %d started just now", folder, found, child.Process.Pid)
	}
	if !strings.Contains(found[0].Command, "sleep 30") {
		t.Fatalf("process command = %q", found[0].Command)
	}
}

func TestProcessCommandsKeepSpacesAndTheWholeCommand(t *testing.T) {
	now := time.Date(2026, 11, 20, 14, 2, 31, 0, time.UTC)
	got, err := Commands("PID ELAPSED COMMAND\n48211 31:03 npm test --workspaces  -- fake value\n48230 00:01 [exited]\n", now)
	if err != nil || len(got) != 2 || got[0].Command != "npm test --workspaces  -- fake value" || got[0].StartedAt.Format(time.RFC3339) != "2026-11-20T13:31:28Z" || got[1].Command != "[exited]" {
		t.Fatalf("Commands = %+v, %v", got, err)
	}
	for _, invalid := range []string{"bad 00:01 command", "1 bad command", "1 00:01", "0 00:01 command"} {
		if _, err := Commands(invalid, now); err == nil {
			t.Fatalf("Commands(%q) succeeded", invalid)
		}
	}
}

func TestProcessesInAFolderRespectCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := In(ctx, aFolder(t), time.Now())
	if err == nil {
		t.Fatal("cancelled process read succeeded")
	}
}

func TestProcessTimesAreReadWithoutACommandColumn(t *testing.T) {
	now := time.Date(2026, 11, 20, 14, 2, 31, 0, time.UTC)
	got, err := Times("PID ELAPSED\n48211 31:03\n48230 1-02:03:04\n", now)
	if err != nil || len(got) != 2 || got[0].PID != 48211 || got[0].StartedAt.Format(time.RFC3339) != "2026-11-20T13:31:28Z" || got[1].StartedAt.Format(time.RFC3339) != "2026-11-19T11:59:27Z" {
		t.Fatalf("Times = %+v, %v", got, err)
	}
	for _, invalid := range []string{"PID ELAPSED\n48211 unknown", "PID ELAPSED\nnot-a-pid 00:01", "PID ELAPSED\n48211 00:01 SECRET", "PID ELAPSED\n0 00:00"} {
		if _, err := Times(invalid, now); err == nil {
			t.Fatalf("Times(%q) succeeded", invalid)
		}
	}
}
