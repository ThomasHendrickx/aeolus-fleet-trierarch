package runpass

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/seen"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

type seenPasses struct {
	snapshots []seen.Snapshot
	failure   error
}

func (s *seenPasses) Save(snapshot seen.Snapshot) error {
	if s.failure != nil {
		return s.failure
	}
	s.snapshots = append(s.snapshots, snapshot)
	return nil
}

func TestASuccessfulPassKeepsTheInboxAndTurnItReadWithTheirTimes(t *testing.T) {
	p := aRunPass(t)
	p.crewed(t)
	saved := &seenPasses{}
	p.pass.Seen = saved
	p.harness.turns[folder] = reconciler.TurnBusy
	p.harness.turnSince = "2026-11-04T11:31:27Z"
	p.fleet.inboxes["aeolus_ct_v1_scout"] = reconciler.Inbox{Waiting: 2, Forced: 1}
	tick := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	p.pass.Now = func() time.Time { at := tick; tick = tick.Add(time.Second); return at }
	p.run(t)
	if len(saved.snapshots) != 1 {
		t.Fatalf("saved %d snapshots, want 1", len(saved.snapshots))
	}
	got := saved.snapshots[0]
	ship := got.Ships[scout]
	if ship.Inbox.Waiting != 2 || ship.Inbox.Forced != 1 || ship.Turn.State != "busy" || ship.Turn.Since != "2026-11-04T11:31:27Z" {
		t.Fatalf("snapshot = %+v", got)
	}
	turnAt, e1 := time.Parse(time.RFC3339, ship.Turn.SeenAt)
	inboxAt, e2 := time.Parse(time.RFC3339, ship.Inbox.SeenAt)
	passAt, e3 := time.Parse(time.RFC3339, got.PassAt)
	if e1 != nil || e2 != nil || e3 != nil || !turnAt.Before(inboxAt) || !inboxAt.Before(passAt) {
		t.Fatalf("observation times = %+v, passAt %s", ship, got.PassAt)
	}
	if len(p.fleet.asked) != 2 {
		t.Fatalf("inbox reads = %d, want only one more read", len(p.fleet.asked))
	}
}

func TestAFailedPassKeepsTheLastSuccessfulSnapshot(t *testing.T) {
	p := aRunPass(t)
	p.crewed(t)
	saved := &seenPasses{}
	p.pass.Seen = saved
	p.run(t)
	before := append([]seen.Snapshot{}, saved.snapshots...)
	p.fleet.cannotReadClears = errors.New("fleet unreachable")
	p.run(t)
	if !reflect.DeepEqual(saved.snapshots, before) {
		t.Fatalf("failed pass wrote %+v, want %+v", saved.snapshots, before)
	}
}

func TestAPassDropsObservationsForSessionsThatDoNotRun(t *testing.T) {
	for _, status := range []string{"absent", "exited"} {
		t.Run(status, func(t *testing.T) {
			p := aRunPass(t)
			p.crewed(t)
			saved := &seenPasses{}
			p.pass.Seen = saved
			p.run(t)
			p.fleet.asked = nil
			p.sessions.observed = nil
			if status == "exited" {
				p.sessions.observed = []sessions.Observed{{ShipID: scout, Status: "exited"}}
			}
			p.run(t)
			if len(saved.snapshots) != 2 || len(saved.snapshots[1].Ships) != 0 || len(p.fleet.asked) != 0 {
				t.Fatalf("snapshots = %+v, inbox reads = %d", saved.snapshots, len(p.fleet.asked))
			}
		})
	}
}

func TestAFailedSnapshotWriteFailsThePassAndKeepsItsReasonUntilSuccess(t *testing.T) {
	p := aRunPass(t)
	p.crewed(t)
	saved := &seenPasses{}
	p.pass.Seen = saved
	p.run(t)
	saved.failure = errors.New("seen snapshot unwritable")
	err := p.pass.Run()
	if !errors.Is(err, saved.failure) {
		t.Fatalf("Run = %v, want %v", err, saved.failure)
	}
	if len(saved.snapshots) != 1 || p.store.state.PassFailure == nil || p.store.state.PassFailure.Reason != "seen snapshot unwritable" || p.store.state.PassFailure.Since != "2026-11-04T12:00:00.000Z" {
		t.Fatalf("snapshots = %+v, pass failure = %+v", saved.snapshots, p.store.state.PassFailure)
	}
	saved.failure = nil
	p.run(t)
	if len(saved.snapshots) != 2 || p.store.state.PassFailure != nil {
		t.Fatalf("snapshots = %+v, pass failure = %+v", saved.snapshots, p.store.state.PassFailure)
	}
}

func TestAFailedInboxReadNeverPublishesAPartialPass(t *testing.T) {
	p := aRunPass(t)
	p.crewed(t)
	saved := &seenPasses{}
	p.pass.Seen = saved
	p.run(t)
	entry := p.store.state.Entries[scout]
	entry.ShipID, entry.CrewToken = "zzz-second-ship", "fake-second-crew-token"
	p.store.state.Entries[entry.ShipID] = entry
	p.sessions.observed = append(p.sessions.observed, sessions.Observed{ShipID: entry.ShipID, Status: "running"})
	p.fleet.inboxErrorFor = entry.CrewToken
	p.fleet.asked = nil
	p.run(t)
	if len(p.fleet.asked) != 2 || len(saved.snapshots) != 1 || p.store.state.PassFailure == nil {
		t.Fatalf("inbox reads = %d, snapshots = %+v, failure = %+v", len(p.fleet.asked), saved.snapshots, p.store.state.PassFailure)
	}
}
