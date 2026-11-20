package folderprocess

import (
	"context"
	"testing"
	"time"
)

func TestProcessesInAFolderShowTheirPIDAndStartWithoutCommands(t *testing.T) {
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
