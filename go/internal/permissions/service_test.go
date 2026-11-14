package permissions

import (
	"context"
	"testing"
	"testing/synctest"
	"time"
)

type reports struct {
	current Report
	writes  []Report
}

func (r *reports) ReadReport(context.Context, string) (Report, error) { return r.current, nil }
func (r *reports) WriteReport(_ context.Context, _ string, report Report) error {
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
				if stored.current.State != "working" || stored.current.Note != "waiting for its owner: Run `npm install`" {
					t.Fatalf("report = %+v", stored.current)
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
		stored.current = Report{State: "blocked", Note: "newer report", Revision: "newer"}
		cancel()
		<-done
		if stored.current.Note != "newer report" || len(stored.writes) != 1 {
			t.Fatalf("report = %+v, writes %d", stored.current, len(stored.writes))
		}
	})
}

func TestNobodyIsAskedOrReportedWhenTheOwnerIsArgoOrUnreadable(t *testing.T) {
	for _, person := range []bool{false} {
		stored := &reports{}
		got := (Service{Owners: &owners{person: person}, Reports: stored, Clock: SystemClock{}}).Await(context.Background(), "scout", "Run `npm install`")
		if got.Message != "this ship's owner is argo: nobody is asked" || len(stored.writes) != 0 {
			t.Fatalf("decision = %+v, reports %v", got, stored.writes)
		}
	}
}
