package permissions

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"
	"unicode/utf16"
)

type reports struct {
	mu      sync.Mutex
	current Report
	writes  []Report
}

func (r *reports) ReadReport(context.Context, string) (Report, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.current, nil
}
func (r *reports) WriteReport(_ context.Context, _ string, report Report) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	report.Revision = string(rune('a' + len(r.writes)))
	r.current = report
	r.writes = append(r.writes, report)
	return nil
}

func TestPersonWaitReportsItsTitleAndRestoresThePreviousReportOnEveryEnd(t *testing.T) {
	for _, end := range []string{"limit", "cancel", "connection close"} {
		t.Run(end, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				before := Report{State: "working", Note: "building issue 385", Revision: "before"}
				stored := &reports{current: before}
				service := Service{Owners: &owners{person: true}, Reports: stored, Clock: SystemClock{}}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				result := make(chan Decision, 1)
				go func() { result <- service.Await(ctx, "scout", "Run `npm install`") }()
				synctest.Wait()
				current, _ := stored.ReadReport(context.Background(), "scout")
				if current.State != "working" || current.Note != "waiting for its owner: Run `npm install`" {
					t.Fatalf("report = %+v", current)
				}
				if end == "limit" {
					time.Sleep(30 * time.Minute)
				} else {
					cancel()
				}
				got := <-result
				if end == "limit" && got.Message != "not answered in 30 minutes; the question was withdrawn" {
					t.Fatal(got)
				}
				if stored.current.State != before.State || stored.current.Note != before.Note || len(stored.writes) != 2 {
					t.Fatalf("restored = %+v, writes %d", stored.current, len(stored.writes))
				}
			})
		})
	}
}

func TestPermissionWaitLeavesANewerReportInPlace(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		stored := &reports{current: Report{State: "working", Note: "before", Revision: "before"}}
		service := Service{Owners: &owners{person: true}, Reports: stored, Clock: SystemClock{}}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan struct{})
		go func() { defer close(done); service.Await(ctx, "scout", "Run `npm install`") }()
		synctest.Wait()
		_ = stored.WriteReport(context.Background(), "scout", Report{State: "blocked", Note: "newer report"})
		cancel()
		<-done
		if stored.current.Note != "newer report" || len(stored.writes) != 2 {
			t.Fatalf("report = %+v, writes %d", stored.current, len(stored.writes))
		}
	})
}

func TestNobodyIsAskedOrReportedWhenTheOwnerIsArgoOrUnreadable(t *testing.T) {
	for _, test := range []struct {
		name    string
		owner   *owners
		message string
	}{
		{"argo", &owners{}, "this ship's owner is argo: nobody is asked"},
		{"unreadable", &owners{err: errors.New("fleet down")}, "could not read this ship's owner: nobody is asked"},
	} {
		t.Run(test.name, func(t *testing.T) {
			stored := &reports{}
			got := (Service{Owners: test.owner, Reports: stored, Clock: SystemClock{}}).Await(context.Background(), "scout", "Run `npm install`")
			if got.Message != test.message || len(stored.writes) != 0 {
				t.Fatalf("decision = %+v, reports %v", got, stored.writes)
			}
		})
	}
}

func TestWaitReportsFitTheFleetsOneLineLimit(t *testing.T) {
	for _, test := range []struct {
		name, title string
		want        int
	}{
		{"exact limit", strings.Repeat("x", 178), 200},
		{"one over", strings.Repeat("x", 179), 200},
		{"non BMP", strings.Repeat("😀", 100), 199},
		{"newline", "Run `echo one\necho two`", 45},
	} {
		t.Run(test.name, func(t *testing.T) {
			note := waitNote(test.title)
			if strings.ContainsAny(note, "\r\n") || len(utf16.Encode([]rune(note))) > 200 {
				t.Fatalf("invalid note %q", note)
			}
			if test.name != "newline" && len(utf16.Encode([]rune(note))) != test.want {
				t.Fatalf("note length %d, want %d", len(utf16.Encode([]rune(note))), test.want)
			}
		})
	}
}
