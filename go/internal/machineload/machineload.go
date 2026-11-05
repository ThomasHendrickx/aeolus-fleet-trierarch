// Package machineload is the machine's load as the trierarch reports it and
// as today's trierarch reads it (#400): memory, swap, CPU and the disk of the
// worktree root, machine totals only. It says what the machine is low on and
// which step of use it is in, and reads the machine at most once a minute.
package machineload

import (
	"fmt"
	"math"
	"sync"
	"time"
)

type Memory struct {
	TotalBytes     int64 `json:"totalBytes"`
	AvailableBytes int64 `json:"availableBytes"`
}

type Swap struct {
	TotalBytes int64 `json:"totalBytes"`
	UsedBytes  int64 `json:"usedBytes"`
}

type CPU struct {
	Cores       int     `json:"cores"`
	LoadAverage float64 `json:"loadAverage"`
}

type Disk struct {
	TotalBytes int64 `json:"totalBytes"`
	FreeBytes  int64 `json:"freeBytes"`
}

// Load is the machine's load in the shape of the trierarch report's `load`.
type Load struct {
	Memory Memory `json:"memory"`
	Swap   *Swap  `json:"swap,omitempty"`
	CPU    CPU    `json:"cpu"`
	Disk   Disk   `json:"disk"`
}

// What a machine can run low on, as argo is told, in the order argo is told.
const (
	LowMemory = "memory"
	LowDisk   = "disk"
)

const (
	// LowMemoryPercent: below this share of memory available the machine is low on memory.
	LowMemoryPercent = 10
	// LowDiskPercent: below this share of its worktree root's disk free the machine is low on disk.
	LowDiskPercent = 5
	// ReadEvery is how often the machine is read: often enough to see memory run out, rarely enough that a report on it does not flood the fleet.
	ReadEvery = time.Minute

	useStepPercent  = 5
	loadPerCoreStep = 0.5
)

// Percent is the share of a whole in percent; ok is false for a whole of nothing.
func Percent(part int64, whole int64) (percent float64, ok bool) {
	if whole <= 0 {
		return 0, false
	}
	return float64(part) / float64(whole) * 100, true
}

// Low is what the machine is low on: memory below 10 % available, the disk below 5 % free. A machine that says it has none of one is not low on it.
func (l Load) Low() []string {
	var low []string
	if memory, ok := Percent(l.Memory.AvailableBytes, l.Memory.TotalBytes); ok && memory < LowMemoryPercent {
		low = append(low, LowMemory)
	}
	if disk, ok := Percent(l.Disk.FreeBytes, l.Disk.TotalBytes); ok && disk < LowDiskPercent {
		low = append(low, LowDisk)
	}
	return low
}

// Steps are the steps a load is in: the trierarch reports its load again only once one of them moves, so a load that always moves does not flood the fleet.
type Steps struct {
	Memory int
	Swap   int
	CPU    int
	Disk   int
}

func stepOf(value float64, step float64) int {
	return int(math.Floor(value / step))
}

// Steps are 5 points of use for memory, swap and disk, and half a load per core for CPU.
func (l Load) Steps() Steps {
	var steps Steps
	if used, ok := Percent(l.Memory.TotalBytes-l.Memory.AvailableBytes, l.Memory.TotalBytes); ok {
		steps.Memory = stepOf(used, useStepPercent)
	}
	if l.Swap != nil {
		if used, ok := Percent(l.Swap.UsedBytes, l.Swap.TotalBytes); ok {
			steps.Swap = stepOf(used, useStepPercent)
		}
	}
	if l.CPU.Cores > 0 {
		steps.CPU = stepOf(l.CPU.LoadAverage/float64(l.CPU.Cores), loadPerCoreStep)
	}
	if used, ok := Percent(l.Disk.TotalBytes-l.Disk.FreeBytes, l.Disk.TotalBytes); ok {
		steps.Disk = stepOf(used, useStepPercent)
	}
	return steps
}

// Source is a machine that says its load.
type Source interface {
	Read() (Load, error)
}

// Reader reads its source at most once a minute, keeping the last load read when the machine cannot be read.
type Reader struct {
	Source Source
	Now    func() time.Time
	Log    func(line string)

	mutex sync.Mutex
	last  *Load
	at    time.Time
}

// Read is the last load read, none before any could be; isFresh is whether this call read the machine.
func (r *Reader) Read() (load *Load, isFresh bool) {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	now := r.Now()
	if r.last != nil && now.Sub(r.at) < ReadEvery {
		return r.last, false
	}
	read, err := r.Source.Read()
	if err != nil {
		r.Log(fmt.Sprintf("Could not read the machine load: %v", err))
		return r.last, false
	}
	r.last, r.at = &read, now
	return r.last, true
}
