// Package notices is what the trierarch tells argo or a ship's owner, in the
// shape the ship protocol gives a message to argo: a headline naming the ship,
// a blank line, then short facts in markdown. The sender is the trierarch's
// own ship, named for its machine, so no text names the machine again. Ids sit
// in the facts, never in the headline. The words are today's trierarch's
// (argo-reports.ts), which the contract suite holds.
package notices

import (
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/machineload"
)

// MarkdownContentType is the content type of a message whose body holds lists or links.
const MarkdownContentType = "text/markdown"

// headlineMax is the longest headline a message to argo opens with: one row in the operator inbox, counted in UTF-16 code units as common's argoMessage counts it.
const headlineMax = 80

const ellipsis = "…"

var whitespace = regexp.MustCompile(`\s+`)

// Message is a headline, a blank line and the body.
func Message(headline string, body string) string {
	return headlineOf(headline) + "\n\n" + body
}

// headlineOf is the headline on one line, cut to fit with an ellipsis when longer.
func headlineOf(text string) string {
	line := strings.TrimSpace(whitespace.ReplaceAllString(text, " "))
	units := utf16.Encode([]rune(line))
	if len(units) <= headlineMax {
		return line
	}
	cut := string(utf16.Decode(units[:headlineMax-1]))
	return strings.TrimRight(cut, " \t\n\r") + ellipsis
}

// Ship is a ship as the trierarch knows it: its name once the fleet told it.
type Ship struct {
	ID   string
	Name string
}

func (s Ship) nameOf() string {
	if s.Name != "" {
		return s.Name
	}
	return s.ID
}

func (s Ship) fact() string {
	if s.Name == "" {
		return fmt.Sprintf("- Ship: `%s`", s.ID)
	}
	return fmt.Sprintf("- Ship: %s (`%s`)", s.Name, s.ID)
}

func paragraphs(parts ...string) string {
	return strings.Join(parts, "\n\n")
}

// Crash is the crash report, true for its reader (decision 0045): argo restarts the ship in the console, so a person who owns it is told argo can. failedStart is why its last start failed, empty when it did not.
func Crash(ship Ship, exits int, failedStart string, isForArgo bool) string {
	facts := []string{ship.fact(), "- Status: crashed, its restart budget spent"}
	if failedStart != "" {
		facts = append(facts, "- Its last start: "+failedStart)
	}
	next := "argo can restart it in the console."
	if isForArgo {
		next = "Restart it in the console to crew it again."
	}
	return Message(fmt.Sprintf("%s crashed %d times in an hour", ship.nameOf(), exits), paragraphs(strings.Join(facts, "\n"), next))
}

// OwnerUnreachable is what argo is told after the fleet refused a report to the ship's owner: the report, then why it came to argo.
func OwnerUnreachable(report string, ownerName string, code string, message string) string {
	return paragraphs(report, fmt.Sprintf("Its owner %s could not be reached: %s: %s.", ownerName, code, message))
}

// discardedNamed is how many of the discarded lines are named; the trierarch's log holds them all.
const discardedNamed = 5

// kinds are the kinds of discarded lines, in the order the counts name them.
var kinds = []string{"refused", "deleted", "changed", "renamed", "new", "commit"}

type discardedLine struct {
	kind string
	what string
}

const commitPrefix = "commit "

// refusedPrefix starts the line of a worktree the host did not read, with why: what it held is not known.
const refusedPrefix = "refused, "

// statusWidth is a git status line's two status letters and the space before the path.
const statusWidth = 3

// lineOf is one line of what removing a worktree discards (git status, an unkept commit, or why the host did not read it), in words.
func lineOf(line string) discardedLine {
	if strings.HasPrefix(line, commitPrefix) {
		return discardedLine{"commit", line[len(commitPrefix):]}
	}
	if strings.HasPrefix(line, refusedPrefix) {
		return discardedLine{"refused", line[len(refusedPrefix):]}
	}
	status := line
	if len(status) > 2 {
		status = status[:2]
	}
	what := ""
	if len(line) > statusWidth {
		what = line[statusWidth:]
	}
	switch {
	case status == "??" || strings.Contains(status, "A"):
		return discardedLine{"new", what}
	case strings.Contains(status, "D"):
		return discardedLine{"deleted", what}
	case strings.Contains(status, "R"):
		return discardedLine{"renamed", what}
	}
	return discardedLine{"changed", what}
}

func countsOf(lines []discardedLine) string {
	counts := []string{}
	for _, kind := range kinds {
		count := 0
		for _, line := range lines {
			if line.kind == kind {
				count++
			}
		}
		switch {
		case count == 0:
		case kind == "commit" && count == 1:
			counts = append(counts, "1 commit")
		case kind == "commit":
			counts = append(counts, fmt.Sprintf("%d commits", count))
		default:
			counts = append(counts, fmt.Sprintf("%d %s", count, kind))
		}
	}
	return strings.Join(counts, ", ")
}

// Discarded is what argo is told a released ship's removed worktree held: its git status lines and commits not kept anywhere.
func Discarded(ship Ship, repository string, unsaved []string) string {
	return discarded(ship, repository, unsaved, false)
}

// DiscardedElsewhere is the same for a ship released elsewhere, whose worktree goes before the trierarch crews it again.
func DiscardedElsewhere(ship Ship, repository string, unsaved []string) string {
	return discarded(ship, repository, unsaved, true)
}

func discarded(ship Ship, repository string, unsaved []string, isReleasedElsewhere bool) string {
	lines := make([]discardedLine, 0, len(unsaved))
	for _, line := range unsaved {
		lines = append(lines, lineOf(line))
	}
	named := []string{}
	for _, line := range lines[:min(len(lines), discardedNamed)] {
		named = append(named, fmt.Sprintf("- %s `%s`", line.kind, line.what))
	}
	if more := len(lines) - len(named); more > 0 {
		named = append(named, fmt.Sprintf("- and %d more, in this trierarch's log", more))
	}
	facts := strings.Join([]string{ship.fact(), "- Worktree: " + repository, "- Discarded: " + countsOf(lines)}, "\n")
	parts := []string{facts, strings.Join(named, "\n")}
	headline := ship.nameOf() + " released: unpushed work discarded"
	if isReleasedElsewhere {
		parts = append([]string{"The trierarch removed its worktree before crewing it again."}, parts...)
		headline = ship.nameOf() + " released elsewhere: unpushed work discarded"
	}
	return Message(headline, paragraphs(parts...))
}

// ModelRefused is what argo is told when a session refused the model it launched with.
func ModelRefused(ship Ship, harness string, version string, model string) string {
	facts := strings.Join([]string{ship.fact(), fmt.Sprintf("- Harness: %s %s", harness, version), "- Model: " + model}, "\n")
	return Message(fmt.Sprintf("%s refused the model %s for %s", harness, model, ship.nameOf()), paragraphs(facts, "This machine offers the model no more at this version, until `aeolus-trierarch detect` runs by hand."))
}

// StoppedOffering is what argo is told when the machine stopped offering itself after the starts of several ships failed in a row (#853): how many, the first reason and how it offers itself again.
func StoppedOffering(ships int, firstReason string) string {
	facts := fmt.Sprintf("- Failed in a row: the starts of %d ships\n- First: %s", ships, firstReason)
	return Message("Session starts fail here: this machine takes no new ships", paragraphs(facts, "It offers itself again for one start 10 minutes after its last failed start, and for good once a start succeeds or the trierarch starts with a changed configuration."))
}

// SettingsRefused is what argo is told when the trierarch cannot crew a ship's settings and the fleet refused to take the request back.
func SettingsRefused(ship Ship, settingsVersion int, why string) string {
	facts := strings.Join([]string{ship.fact(), fmt.Sprintf("- Settings version: %d", settingsVersion), "- Why: " + why}, "\n")
	return Message("Cannot crew "+ship.nameOf()+" with its settings", facts)
}

// IdentityGone is what argo is told when a running, restarting or crashed ship's folder holds no identity.
func IdentityGone(ship Ship) string {
	return Message(ship.nameOf()+" is no longer woken: its folder holds no identity", paragraphs(ship.fact(), "The trierarch can no longer report on its behalf, watch its inbox or wake it. Restart it in the console to crew it again."))
}

// DetectionProblem is what argo is told when detection could not find what a harness offers, such as Claude Code naming no model alias (#365).
func DetectionProblem(harness string, version string, problem string) string {
	return Message(fmt.Sprintf("%s %s: detection found a problem", harness, version), problem)
}

var harnessNames = map[string]string{"claude-code": "Claude Code", "codex": "Codex"}

// KeyNotReady is what argo is told of a harness's API key that holds its ships back: which harness, the state since when, the ships that wait, and how the key gets ready again. state is outOfCredit, refused or none; at is when the vendor's answer set it, empty when it has no time.
func KeyNotReady(harness string, state string, at string, ships []Ship) string {
	name, ok := harnessNames[harness]
	if !ok {
		name = harness
	}
	since := ""
	if at != "" {
		since = " since " + at
	}
	var headline, said, next string
	switch state {
	case "outOfCredit":
		headline, said = name+"'s API key is out of credit", "out of credit"+since
		next = fmt.Sprintf("It is checked every 15 minutes; aeolus-trierarch login %s --check checks it at once.", harness)
	case "refused":
		headline, said = name+"'s API key was refused", "refused by its vendor"+since
		next = fmt.Sprintf("Give it a new key with aeolus-trierarch login %s --api-key.", harness)
	default:
		headline, said = name+" has no API key", "no key"
		next = fmt.Sprintf("Give it one with aeolus-trierarch login %s --api-key.", harness)
	}
	waiting := make([]string, 0, len(ships))
	for _, ship := range ships {
		if ship.Name == "" {
			waiting = append(waiting, fmt.Sprintf("`%s`", ship.ID))
		} else {
			waiting = append(waiting, fmt.Sprintf("%s (`%s`)", ship.Name, ship.ID))
		}
	}
	facts := strings.Join([]string{"- Harness: " + harness, "- State: " + said, "- Ships that wait: " + strings.Join(waiting, ", ")}, "\n")
	return Message(headline, paragraphs(facts, next))
}

const (
	gib = 1 << 30
	gb  = 1_000_000_000
)

// tenths is a number with one decimal, a tie rounded up as JavaScript's toFixed does, where Go's rounds it to even.
func tenths(value float64) string {
	if scaled := value * 10; scaled == math.Floor(scaled)+0.5 && new(big.Rat).Mul(new(big.Rat).SetFloat64(value), big.NewRat(20, 1)).IsInt() {
		return strconv.FormatFloat((math.Floor(scaled)+1)/10, 'f', 1, 64)
	}
	return strconv.FormatFloat(value, 'f', 1, 64)
}

// LowResource is what argo is told when the machine is low on memory or disk (#400). The trierarch stops nothing for it: freeing memory or disk is the operator's.
func LowResource(resource string, load machineload.Load) string {
	memory, disk := load.Memory, load.Disk
	var headline string
	if resource == machineload.LowMemory {
		headline = fmt.Sprintf("Low on memory: %d %% available", int(math.Round(float64(memory.AvailableBytes)/float64(memory.TotalBytes)*100)))
	} else {
		headline = fmt.Sprintf("Low on disk: %d %% free", int(math.Round(float64(disk.FreeBytes)/float64(disk.TotalBytes)*100)))
	}
	facts := fmt.Sprintf("- Memory: %s of %s GiB available\n- Disk: %s of %s GB free", tenths(float64(memory.AvailableBytes)/gib), tenths(float64(memory.TotalBytes)/gib), tenths(float64(disk.FreeBytes)/gb), tenths(float64(disk.TotalBytes)/gb))
	return Message(headline, paragraphs(facts, "The trierarch stops no session for it."))
}
