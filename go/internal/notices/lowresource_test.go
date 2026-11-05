package notices

import (
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/machineload"
)

func TestLowResourceNamesWhatIsLowThenTheMemoryAndDiskLeft(t *testing.T) {
	load := machineload.Load{
		Memory: machineload.Memory{TotalBytes: 16 << 30, AvailableBytes: 1 << 30},
		Disk:   machineload.Disk{TotalBytes: 500_000_000_000, FreeBytes: 100_000_000_000},
	}
	facts := "- Memory: 1.0 of 16.0 GiB available\n- Disk: 100.0 of 500.0 GB free\n\nThe trierarch stops no session for it."
	if got, want := LowResource("memory", load), "Low on memory: 6 % available\n\n"+facts; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if got, want := LowResource("disk", load), "Low on disk: 20 % free\n\n"+facts; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestLowResourceRoundsATenthOfAGigabyteHalfUpAsTodaysDoes(t *testing.T) {
	load := machineload.Load{
		Memory: machineload.Memory{TotalBytes: 16 << 30, AvailableBytes: (5 << 30) / 4}, // 1.25 GiB
		Disk:   machineload.Disk{TotalBytes: 1_000_000_000, FreeBytes: 50_000_000},      // 0.05 GB
	}
	got := LowResource("memory", load)
	want := "Low on memory: 8 % available\n\n- Memory: 1.3 of 16.0 GiB available\n- Disk: 0.1 of 1.0 GB free\n\nThe trierarch stops no session for it."
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
