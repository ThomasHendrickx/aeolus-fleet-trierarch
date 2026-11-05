package sessions

import (
	"testing"
	"time"
)

func TestTheBootTimeIsTheMachinesOnThisSystem(t *testing.T) {
	booted := BootedAt()

	if booted.IsZero() {
		t.Fatal("BootedAt() is zero, want when the machine started")
	}
	if now := time.Now(); !booted.Before(now) || booted.Before(now.AddDate(-10, 0, 0)) {
		t.Errorf("BootedAt() = %v, want a time in the past ten years", booted)
	}
}

func TestTheBootTimeIsTheUptimeBeforeNow(t *testing.T) {
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)

	if got, want := bootedBefore("3600.50 7000.00\n", now), now.Add(-3600500*time.Millisecond); !got.Equal(want) {
		t.Errorf("bootedBefore() = %v, want %v", got, want)
	}
	for _, text := range []string{"", "soon 1\n"} {
		if got := bootedBefore(text, now); !got.IsZero() {
			t.Errorf("bootedBefore(%q) = %v, want zero", text, got)
		}
	}
}
