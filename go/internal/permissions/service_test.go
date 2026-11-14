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

type failingReports struct {
	reports
	read       int
	failsRead  int
	failsWrite bool
}

func (r *failingReports) ReadReport(ctx context.Context, ship string) (Report, error) {
	r.read++
	if r.read == r.failsRead {
		return Report{}, errors.New("report unavailable")
	}
	return r.reports.ReadReport(ctx, ship)
}
func (r *failingReports) WriteReport(ctx context.Context, ship string, report Report) error {
	if r.failsWrite {
		return errors.New("report unavailable")
	}
	return r.reports.WriteReport(ctx, ship, report)
}

func TestReportFailuresAreLoggedAndKeepThePermissionWaitUntilItsLimitOrCancel(t *testing.T) {
	for _, failure := range []string{"entry read", "waiting report", "waiting revision"} {
		for _, end := range []string{"limit", "cancel"} {
			t.Run(failure+"/"+end, func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					stored := &failingReports{reports: reports{current: Report{State: "working", Note: "before"}}}
					switch failure {
					case "entry read":
						stored.failsRead = 1
					case "waiting report":
						stored.failsWrite = true
					case "waiting revision":
						stored.failsRead = 2
					}
					var logs []string
					service := Service{Owners: &owners{person: true}, Reports: stored, Clock: SystemClock{}, Log: func(message string) { logs = append(logs, message) }}
					ctx, cancel := context.WithCancel(context.Background())
					defer cancel()
					result := make(chan Decision, 1)
					go func() { result <- service.Await(ctx, "scout", "Run `npm install`") }()
					synctest.Wait()
					select {
					case got := <-result:
						t.Fatalf("report failure ended the permission wait: %+v", got)
					default:
					}
					if end == "limit" {
						time.Sleep(30 * time.Minute)
					} else {
						cancel()
					}
					got := <-result
					message := "permission call cancelled"
					if end == "limit" {
						message = "not answered in 30 minutes; the question was withdrawn"
					}
					if got.Message != message || len(logs) != 1 || !strings.Contains(logs[0], "report unavailable") {
						t.Fatalf("decision = %+v, logs = %v", got, logs)
					}
				})
			})
		}
	}
}
