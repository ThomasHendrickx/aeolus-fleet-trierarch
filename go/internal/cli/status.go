package cli

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/service"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/state"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/style"
)

// entryStates are the states of an entry, in the order status counts them.
var entryStates = []string{"crewing", "running", "restarting", "crashed", "releasing"}

// StatusReport is how the trierarch stands on this machine, in the shape today's trierarch answers.
type StatusReport struct {
	// Version is the installed version: what the command runs.
	Version string `json:"version"`
	// RunningVersion is the version the running service said when it started; none when it does not run or did not say.
	RunningVersion string `json:"runningVersion,omitempty"`
	// Plugins is the aeolus-fleet plugin version per configured harness; null where the harness has none.
	Plugins      map[string]*string `json:"plugins"`
	Repositories []string           `json:"repositories"`
	Service      service.Status     `json:"service"`
	Fleet        StatusFleet        `json:"fleet"`
	Caps         StatusCaps         `json:"caps"`
	Entries      map[string]int     `json:"entries"`
	Kept         []StatusKept       `json:"kept"`
	Orphans      []string           `json:"orphans"`
	// PassFailure is why the last pass failed and since when; none when it succeeded.
	PassFailure *reconciler.PassFailure `json:"passFailure,omitempty"`
}

// StatusFleet is the fleet and the trierarch's own lease: valid, ended or unreachable.
type StatusFleet struct {
	URL    string `json:"url"`
	ShipID string `json:"shipId,omitempty"`
	Lease  string `json:"lease"`
}

// StatusCaps are the caps in use.
type StatusCaps struct {
	Ships   StatusCap `json:"ships"`
	Running StatusCap `json:"running"`
}

// StatusCap is how many are used of a cap.
type StatusCap struct {
	Used int `json:"used"`
	Cap  int `json:"cap"`
}

// StatusKept is a worktree kept because it had changes, until a human clears it.
type StatusKept struct {
	ShipID     string `json:"shipId"`
	Repository string `json:"repository"`
	Path       string `json:"path"`
}

// status is how the trierarch stands on this machine, from what is on it.
func status(at paths.Paths, machine Machine, look style.Style) (answer, error) {
	kept, err := crew.Read(at.CrewToken)
	if err != nil {
		return answer{}, err
	}
	configuration, err := config.Load(at.Config)
	if err != nil {
		return answer{}, err
	}
	saved, err := state.File{Path: at.State}.Load()
	if err != nil {
		return answer{}, err
	}
	manager, err := machine.Service(at).Status()
	if err != nil {
		return answer{}, err
	}
	if manager.IsRunning && manager.PID > 0 && machine.StartedAt != nil {
		manager.Since = machine.StartedAt(manager.PID)
	}
	observed, err := machine.Sessions(at).List()
	if err != nil {
		return answer{}, err
	}
	lease := "valid"
	if held, err := machine.IsLeaseHeld(kept.FleetURL, kept.CrewToken); err != nil {
		lease = "unreachable"
	} else if !held {
		lease = "ended"
	}
	report := StatusReport{
		Version:      Version,
		Plugins:      map[string]*string{},
		Repositories: slices.AppendSeq([]string{}, maps.Keys(configuration.Repositories)),
		Service:      manager,
		Fleet:        StatusFleet{URL: kept.FleetURL, ShipID: kept.ShipID, Lease: lease},
		Caps: StatusCaps{
			Ships:   StatusCap{Used: len(saved.Entries), Cap: configuration.Caps.Ships},
			Running: StatusCap{Used: countRunning(observed), Cap: configuration.Caps.Running},
		},
		Entries:     map[string]int{},
		Kept:        keptOf(saved.Kept),
		Orphans:     orphansOf(saved.Orphans),
		PassFailure: saved.PassFailure,
	}
	slices.Sort(report.Repositories)
	plugins := machine.Plugins()
	for harness := range configuration.Harnesses {
		if version := plugins.Version(harness); version != "" {
			report.Plugins[harness] = &version
		} else {
			report.Plugins[harness] = nil
		}
	}
	for _, each := range entryStates {
		report.Entries[each] = 0
	}
	for _, entry := range saved.Entries {
		report.Entries[entry.State]++
	}
	// Only the service's own process counts: a file left by an earlier process, or by a run outside the service, says nothing of it.
	if running, isRead := readRunning(at.Running); manager.IsRunning && isRead && running.PID == manager.PID {
		report.RunningVersion = running.Version
	}
	return answer{data: report, text: describeStatus(report, look)}, nil
}

func countRunning(observed []sessions.Observed) int {
	count := 0
	for _, each := range observed {
		if each.Status == "running" {
			count++
		}
	}
	return count
}

// keptOf is the kept worktrees the state holds, as the entries it saved say them.
func keptOf(saved []any) []StatusKept {
	kept := []StatusKept{}
	for _, each := range saved {
		var one StatusKept
		if reencode(each, &one) {
			kept = append(kept, one)
		}
	}
	return kept
}

// orphansOf is the path of each orphan the state holds.
func orphansOf(saved []any) []string {
	orphans := []string{}
	for _, each := range saved {
		var one struct {
			Path string `json:"path"`
		}
		if reencode(each, &one) {
			orphans = append(orphans, one.Path)
		}
	}
	return orphans
}

// reencode reads a value the state decoded loosely as the shape given, and says whether it fits.
func reencode(value any, into any) bool {
	text, err := json.Marshal(value)
	return err == nil && json.Unmarshal(text, into) == nil
}

func describeService(manager service.Status, look style.Style) string {
	if !manager.IsInstalled {
		return look.Tone(style.Bad, "not installed (aeolus-trierarch install)")
	}
	if !manager.IsRunning {
		return look.Tone(style.Busy, "installed, not running (aeolus-trierarch start)")
	}
	parts := []string{look.Tone(style.Good, "running")}
	if manager.PID > 0 {
		parts = append(parts, fmt.Sprintf("pid %d", manager.PID))
	}
	if manager.Since != "" {
		parts = append(parts, "since "+manager.Since)
	}
	return strings.Join(parts, ", ")
}

func describeFleet(fleet StatusFleet, look style.Style) string {
	ship := fleet.ShipID
	if ship == "" {
		ship = "its ship"
	}
	switch fleet.Lease {
	case "valid":
		return fmt.Sprintf("%s, %s", fleet.URL, look.Tone(style.Good, "the lease of "+ship+" is valid"))
	case "ended":
		return fmt.Sprintf("%s, %s: its ship was released or retired, so it crews nothing", fleet.URL, look.Tone(style.Bad, "the lease of "+ship+" ended"))
	}
	return fleet.URL + " " + look.Tone(style.Bad, "cannot be reached")
}

const restart = "aeolus-trierarch restart"

// describeVersion is the installed version, and where the running service runs another, what to do about it, in the busy tone.
func describeVersion(report StatusReport, look style.Style) string {
	if !report.Service.IsRunning || report.RunningVersion == report.Version {
		return report.Version
	}
	if report.RunningVersion == "" {
		return look.Tone(style.Busy, fmt.Sprintf("%s installed, the running service did not say its version, so it started before %s: restart it to run the installed one (%s)", report.Version, report.Version, restart))
	}
	return look.Tone(style.Busy, fmt.Sprintf("%s installed, %s running: restart the service to run the installed one (%s)", report.Version, report.RunningVersion, restart))
}

// describePlugins is each configured harness with the aeolus-fleet plugin version it uses, or that it has none.
func describePlugins(plugins map[string]*string, look style.Style) string {
	if len(plugins) == 0 {
		return "no harness configured"
	}
	parts := []string{}
	for _, harness := range slices.Sorted(maps.Keys(plugins)) {
		if plugins[harness] == nil {
			parts = append(parts, look.Tone(style.Bad, harness+" not found (install the aeolus-fleet plugin for it)"))
		} else {
			parts = append(parts, harness+" "+*plugins[harness])
		}
	}
	return strings.Join(parts, ", ")
}

// describeStatus is each line its label and how it stands; where the style colours, the label strong and each state in its tone.
func describeStatus(report StatusReport, look style.Style) string {
	line := func(label string, text string) string { return look.Tone(style.Strong, label+":") + " " + text }
	or := func(empty bool, none string, text func() string) string {
		if empty {
			return none
		}
		return text()
	}
	entries := []string{}
	for _, each := range entryStates {
		if count := report.Entries[each]; count > 0 {
			entries = append(entries, look.Tone(style.OfState(each), fmt.Sprintf("%s %d", each, count)))
		}
	}
	lastPass := look.Tone(style.Good, "succeeded")
	if report.PassFailure != nil {
		lastPass = look.Tone(style.Bad, fmt.Sprintf("failing since %s: %s", report.PassFailure.Since, report.PassFailure.Reason))
	}
	keptWorktrees := []string{}
	for _, each := range report.Kept {
		keptWorktrees = append(keptWorktrees, fmt.Sprintf("%s (%s)", each.Path, each.ShipID))
	}
	return strings.Join([]string{
		line("Version", describeVersion(report, look)),
		line("Aeolus Fleet plugin", describePlugins(report.Plugins, look)),
		line("Repositories", or(len(report.Repositories) == 0, "none", func() string { return strings.Join(report.Repositories, ", ") })),
		line("Service", describeService(report.Service, look)),
		line("Fleet", describeFleet(report.Fleet, look)),
		line("Caps", fmt.Sprintf("%d of %d ships crewed here, %d of %d sessions running", report.Caps.Ships.Used, report.Caps.Ships.Cap, report.Caps.Running.Used, report.Caps.Running.Cap)),
		line("Last pass", lastPass),
		line("Entries", or(len(entries) == 0, "none", func() string { return strings.Join(entries, ", ") })),
		line("Kept worktrees", or(len(keptWorktrees) == 0, "none", func() string { return look.Tone(style.Busy, strings.Join(keptWorktrees, ", ")) })),
		line("Orphans", or(len(report.Orphans) == 0, "none", func() string { return look.Tone(style.Busy, strings.Join(report.Orphans, ", ")) })),
	}, "\n")
}
