package machineload

import (
	"errors"
	"testing"
	"time"
)

func aLoad(memoryAvailable, memoryTotal, diskFree, diskTotal int64) Load {
	return Load{Memory: Memory{TotalBytes: memoryTotal, AvailableBytes: memoryAvailable}, CPU: CPU{Cores: 4, LoadAverage: 1}, Disk: Disk{TotalBytes: diskTotal, FreeBytes: diskFree}}
}

func TestAMachineIsLowOnMemoryBelowTenPercentAvailableAndOnDiskBelowFivePercentFree(t *testing.T) {
	cases := []struct {
		name string
		load Load
		want []string
	}{
		{"enough of both", aLoad(10, 100, 5, 100), nil},
		{"memory below ten percent", aLoad(9, 100, 50, 100), []string{"memory"}},
		{"disk below five percent", aLoad(50, 100, 4, 100), []string{"disk"}},
		{"both, memory first", aLoad(9, 100, 4, 100), []string{"memory", "disk"}},
		{"a machine that says it has no memory is not low on it", aLoad(0, 0, 50, 100), nil},
		{"a machine that says it has no disk is not low on it", aLoad(50, 100, 0, 0), nil},
	}
	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			got := each.load.Low()
			if len(got) != len(each.want) {
				t.Fatalf("got %v, want %v", got, each.want)
			}
			for i := range got {
				if got[i] != each.want[i] {
					t.Fatalf("got %v, want %v", got, each.want)
				}
			}
		})
	}
}

func TestAStepIsFivePointsOfUseForMemorySwapAndDiskAndHalfALoadPerCoreForCPU(t *testing.T) {
	load := aLoad(30, 100, 40, 100)
	load.Swap = &Swap{TotalBytes: 100, UsedBytes: 12}
	load.CPU = CPU{Cores: 4, LoadAverage: 3.1}
	want := Steps{Memory: 14, Swap: 2, CPU: 1, Disk: 12}
	if got := load.Steps(); got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestAMachineWithNoSwapIsInStepZeroOfIt(t *testing.T) {
	if got := aLoad(30, 100, 40, 100).Steps().Swap; got != 0 {
		t.Fatalf("got %d", got)
	}
}

func TestMemoryIsMemTotalAndMemAvailableOfProcMeminfo(t *testing.T) {
	meminfo := "MemTotal:       16384000 kB\nMemFree:          100000 kB\nMemAvailable:    8192000 kB\nSwapTotal:       2097152 kB\nSwapFree:        1048576 kB\n"
	memory, ok := MeminfoMemory(meminfo)
	if !ok || memory != (Memory{TotalBytes: 16384000 * 1024, AvailableBytes: 8192000 * 1024}) {
		t.Fatalf("got %+v %v", memory, ok)
	}
	swap := MeminfoSwap(meminfo)
	if swap == nil || *swap != (Swap{TotalBytes: 2097152 * 1024, UsedBytes: 1048576 * 1024}) {
		t.Fatalf("got %+v", swap)
	}
}

func TestMemoryIsNotReadFromAMeminfoWithoutIt(t *testing.T) {
	if _, ok := MeminfoMemory("MemTotal: 1 kB\n"); ok {
		t.Fatal("read memory with no MemAvailable")
	}
	if MeminfoSwap("MemTotal: 1 kB\n") != nil {
		t.Fatal("read swap with none named")
	}
}

func TestAMacsAvailableMemoryIsItsFreeInactiveSpeculativeAndPurgeablePages(t *testing.T) {
	vmStat := "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               1000.\nPages active:                             5000.\nPages inactive:                           2000.\nPages speculative:                         300.\nPages purgeable:                           700.\n"
	got := MacMemory("68719476736\n", vmStat)
	if want := (Memory{TotalBytes: 68719476736, AvailableBytes: 4000 * 16384}); got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestAMacsSwapIsRoundedFromSwapusageInMegabytes(t *testing.T) {
	swap := MacSwap("total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)")
	if swap == nil || *swap != (Swap{TotalBytes: 2048 << 20, UsedBytes: 1074266112}) {
		t.Fatalf("got %+v", swap)
	}
	if MacSwap("nothing") != nil {
		t.Fatal("read swap from nothing")
	}
}

func TestTheLoadAverageIsTheFirstOfProcLoadavgAndOfSysctlsList(t *testing.T) {
	if got := LinuxLoadAverage("6.28 5.71 5.26 4/3054 2499056\n"); got != 6.28 {
		t.Fatalf("got %v", got)
	}
	if got := MacLoadAverage("{ 1.50 2.00 2.50 }\n"); got != 1.5 {
		t.Fatalf("got %v", got)
	}
	if LinuxLoadAverage("") != 0 || MacLoadAverage("") != 0 {
		t.Fatal("a load average out of nothing")
	}
}

type aSource struct {
	loads []Load
	err   error
	reads int
}

func (s *aSource) Read() (Load, error) {
	s.reads++
	if s.err != nil {
		return Load{}, s.err
	}
	return s.loads[min(s.reads, len(s.loads))-1], nil
}

func TestTheLoadIsReadAtMostOnceAMinute(t *testing.T) {
	at := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	source := &aSource{loads: []Load{aLoad(50, 100, 50, 100), aLoad(40, 100, 50, 100)}}
	reader := &Reader{Source: source, Now: func() time.Time { return at }, Log: func(string) {}}
	first, isFresh := reader.Read()
	if first == nil || !isFresh {
		t.Fatalf("got %v %v", first, isFresh)
	}
	at = at.Add(59 * time.Second)
	again, isFresh := reader.Read()
	if again == nil || isFresh || again.Memory.AvailableBytes != 50 || source.reads != 1 {
		t.Fatalf("got %v %v after %d reads", again, isFresh, source.reads)
	}
	at = at.Add(time.Second)
	next, isFresh := reader.Read()
	if next == nil || !isFresh || next.Memory.AvailableBytes != 40 || source.reads != 2 {
		t.Fatalf("got %v %v after %d reads", next, isFresh, source.reads)
	}
}

func TestAMachineThatCannotBeReadKeepsTheLastLoadReadAndLogsIt(t *testing.T) {
	at := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	source := &aSource{loads: []Load{aLoad(50, 100, 50, 100)}}
	var logged []string
	reader := &Reader{Source: source, Now: func() time.Time { return at }, Log: func(line string) { logged = append(logged, line) }}
	reader.Read()
	source.err = errors.New("no /proc")
	at = at.Add(time.Minute)
	kept, isFresh := reader.Read()
	if kept == nil || isFresh || kept.Memory.AvailableBytes != 50 {
		t.Fatalf("got %v %v", kept, isFresh)
	}
	if len(logged) != 1 || logged[0] != "Could not read the machine load: no /proc" {
		t.Fatalf("logged %q", logged)
	}
}

func TestAMachineThatCannotBeReadBeforeAnyReadHasNoLoad(t *testing.T) {
	reader := &Reader{Source: &aSource{err: errors.New("no /proc")}, Now: time.Now, Log: func(string) {}}
	if load, isFresh := reader.Read(); load != nil || isFresh {
		t.Fatalf("got %v %v", load, isFresh)
	}
}

func TestTheSystemReadsARealMachinesLoad(t *testing.T) {
	load, err := System{WorktreeRoot: t.TempDir() + "/not/made/yet"}.Read()
	if err != nil {
		t.Fatal(err)
	}
	if load.Memory.TotalBytes <= 0 || load.Memory.AvailableBytes <= 0 || load.Memory.AvailableBytes > load.Memory.TotalBytes {
		t.Fatalf("memory %+v", load.Memory)
	}
	if load.CPU.Cores <= 0 || load.Disk.TotalBytes <= 0 || load.Disk.FreeBytes > load.Disk.TotalBytes {
		t.Fatalf("got %+v", load)
	}
}
