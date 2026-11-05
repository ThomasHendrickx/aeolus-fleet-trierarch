package machineload

import (
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

const kib = 1024

func meminfoField(meminfo string, name string) (int64, bool) {
	found := regexp.MustCompile(`(?m)^` + name + `:\s+(\d+) kB$`).FindStringSubmatch(meminfo)
	if found == nil {
		return 0, false
	}
	value, err := strconv.ParseInt(found[1], 10, 64)
	return value * kib, err == nil
}

// MeminfoMemory is a Linux machine's memory from /proc/meminfo: what it calls available is what Node's free memory is.
func MeminfoMemory(meminfo string) (Memory, bool) {
	total, hasTotal := meminfoField(meminfo, "MemTotal")
	available, hasAvailable := meminfoField(meminfo, "MemAvailable")
	return Memory{TotalBytes: total, AvailableBytes: available}, hasTotal && hasAvailable
}

// MeminfoSwap is the swap a Linux machine has and uses; none when /proc/meminfo does not say.
func MeminfoSwap(meminfo string) *Swap {
	total, hasTotal := meminfoField(meminfo, "SwapTotal")
	free, hasFree := meminfoField(meminfo, "SwapFree")
	if !hasTotal || !hasFree {
		return nil
	}
	return &Swap{TotalBytes: total, UsedBytes: total - free}
}

func pagesOf(vmStat string, name string) int64 {
	found := regexp.MustCompile(`(?m)^Pages ` + name + `:\s+(\d+)\.$`).FindStringSubmatch(vmStat)
	if found == nil {
		return 0
	}
	pages, _ := strconv.ParseInt(found[1], 10, 64)
	return pages
}

// MacMemory is a Mac's memory from `sysctl -n hw.memsize` and vm_stat: as available its free, inactive, speculative and purgeable pages, as Activity Monitor counts what is not used.
func MacMemory(memsize string, vmStat string) Memory {
	var pageSize int64
	if found := regexp.MustCompile(`page size of (\d+) bytes`).FindStringSubmatch(vmStat); found != nil {
		pageSize, _ = strconv.ParseInt(found[1], 10, 64)
	}
	var pages int64
	for _, name := range []string{"free", "inactive", "speculative", "purgeable"} {
		pages += pagesOf(vmStat, name)
	}
	total, _ := strconv.ParseInt(strings.TrimSpace(memsize), 10, 64)
	return Memory{TotalBytes: total, AvailableBytes: pages * pageSize}
}

// MacSwap is the swap a Mac has and uses, from `sysctl -n vm.swapusage`.
func MacSwap(swapUsage string) *Swap {
	bytesOf := func(name string) (int64, bool) {
		found := regexp.MustCompile(name + ` = (\d+(?:\.\d+)?)M`).FindStringSubmatch(swapUsage)
		if found == nil {
			return 0, false
		}
		megabytes, err := strconv.ParseFloat(found[1], 64)
		return int64(math.Round(megabytes * (1 << 20))), err == nil
	}
	total, hasTotal := bytesOf("total")
	used, hasUsed := bytesOf("used")
	if !hasTotal || !hasUsed {
		return nil
	}
	return &Swap{TotalBytes: total, UsedBytes: used}
}

// LinuxLoadAverage is the 1-minute load average, the first field of /proc/loadavg; 0 when it is not there.
func LinuxLoadAverage(loadavg string) float64 {
	return firstNumber(strings.Fields(loadavg))
}

// MacLoadAverage is the 1-minute load average, the first of `sysctl -n vm.loadavg`'s `{ 1.50 2.00 2.50 }`; 0 when it is not there.
func MacLoadAverage(loadavg string) float64 {
	return firstNumber(strings.Fields(strings.Trim(strings.TrimSpace(loadavg), "{}")))
}

func firstNumber(fields []string) float64 {
	if len(fields) == 0 {
		return 0
	}
	value, _ := strconv.ParseFloat(fields[0], 64)
	return value
}

// System is this machine, as its operating system says its load. Disk: the filesystem of the worktree root, or of the folder it will be made in.
type System struct {
	WorktreeRoot string
}

func (s System) Read() (Load, error) {
	var load Load
	switch runtime.GOOS {
	case "linux":
		meminfo, err := os.ReadFile("/proc/meminfo")
		if err != nil {
			return Load{}, err
		}
		memory, ok := MeminfoMemory(string(meminfo))
		if !ok {
			return Load{}, errors.New("/proc/meminfo names no available memory")
		}
		loadavg, err := os.ReadFile("/proc/loadavg")
		if err != nil {
			return Load{}, err
		}
		load.Memory, load.Swap, load.CPU.LoadAverage = memory, MeminfoSwap(string(meminfo)), LinuxLoadAverage(string(loadavg))
	case "darwin":
		memsize, vmStat, swapUsage, loadavg, err := macReadings()
		if err != nil {
			return Load{}, err
		}
		load.Memory, load.Swap, load.CPU.LoadAverage = MacMemory(memsize, vmStat), MacSwap(swapUsage), MacLoadAverage(loadavg)
	default:
		return Load{}, fmt.Errorf("the load of a %s machine is not read", runtime.GOOS)
	}
	load.CPU.Cores = runtime.NumCPU()
	disk, err := diskOf(s.WorktreeRoot)
	if err != nil {
		return Load{}, err
	}
	load.Disk = disk
	return load, nil
}

func macReadings() (memsize, vmStat, swapUsage, loadavg string, err error) {
	run := func(name string, args ...string) string {
		out, runErr := exec.Command(name, args...).Output()
		if runErr != nil && err == nil {
			err = fmt.Errorf("%s: %w", name, runErr)
		}
		return string(out)
	}
	return run("sysctl", "-n", "hw.memsize"), run("vm_stat"), run("sysctl", "-n", "vm.swapusage"), run("sysctl", "-n", "vm.loadavg"), err
}

// diskOf is the filesystem of the folder, or of the nearest folder above it that exists.
func diskOf(folder string) (Disk, error) {
	var stats syscall.Statfs_t
	err := syscall.Statfs(folder, &stats)
	if err == nil {
		return Disk{TotalBytes: int64(stats.Blocks) * int64(stats.Bsize), FreeBytes: int64(stats.Bavail) * int64(stats.Bsize)}, nil
	}
	parent := filepath.Dir(folder)
	if parent == folder || !errors.Is(err, syscall.ENOENT) {
		return Disk{}, err
	}
	return diskOf(parent)
}
