package claudecode

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
)

// ProbeTimeout is the longest a probe may take: a CLI that hangs is ended, its id neither confirmed nor refused.
const ProbeTimeout = time.Minute

// quickTimeout is the longest --version and --help may take.
const quickTimeout = 10 * time.Second

// unrecognizedModel is how Claude Code says it does not know a model.
const unrecognizedModel = "unrecognized_model"

const probePrompt = "Reply OK"

// Detector detects Claude Code (#365; docs/trierarch.md, "Detected options"). Its CLI lists no models, but it takes aliases, each for the latest of a family, those its --help names and the known families (fable, opus, sonnet, haiku), as --help gives only examples (#308): each is probed once with a short print-mode turn, from a neutral folder and never as a ship, and the exact id it resolves to is read from the answer's modelUsage, so the ids follow the installed CLI with no list to keep. An alias the CLI refuses is left out; one whose probe neither confirms nor refuses it (offline, not logged in) keeps the id it resolved to before at the same version. The effort levels come from --help. Neither has a default: the CLI keeps its own.
type Detector struct {
	Run detection.Runner
	// NeutralFolder is a new empty folder to probe from, so no project's hooks or settings run.
	NeutralFolder func() (string, error)
	// Program is the program to run, `claude` when empty.
	Program string
}

func (d Detector) program() string {
	if d.Program == "" {
		return "claude"
	}
	return d.Program
}

// Version is the version the first word of --version says.
func (d Detector) Version(ctx context.Context) (string, bool) {
	ran := d.Run(ctx, detection.Command{Program: d.program(), Args: []string{"--version"}, Timeout: quickTimeout})
	words := strings.Fields(ran.Stdout)
	if ran.Status != 0 || len(words) == 0 {
		return "", false
	}
	return words[0], true
}

// outcome is what a probe of an alias found: the exact id it resolved to, a refusal, or neither.
type outcome struct {
	id        string
	isRefused bool
}

// resolvedIDOf is the id the probe ran: the one in modelUsage that names the alias, or the only one.
func resolvedIDOf(alias string, usage map[string]json.RawMessage) string {
	var ids []string
	for _, id := range slices.Sorted(maps.Keys(usage)) {
		if detection.IsName(id) {
			ids = append(ids, id)
		}
	}
	if at := slices.IndexFunc(ids, func(id string) bool { return strings.Contains(id, alias) }); at >= 0 {
		return ids[at]
	}
	if len(ids) == 1 {
		return ids[0]
	}
	return ""
}

func outcomeOf(alias string, ran detection.Ran) outcome {
	if strings.Contains(ran.Stdout+"\n"+ran.Stderr, unrecognizedModel) {
		return outcome{isRefused: true}
	}
	if ran.Status != 0 {
		return outcome{}
	}
	var answer struct {
		ModelUsage map[string]json.RawMessage `json:"modelUsage"`
	}
	if json.Unmarshal([]byte(ran.Stdout), &answer) != nil || answer.ModelUsage == nil {
		return outcome{}
	}
	return outcome{id: resolvedIDOf(alias, answer.ModelUsage)}
}

// entryOf is an option's entry in --help on one line: its own line and the lines its description wraps onto (#383), those indented deeper that start no option.
func entryOf(help string, flag string) string {
	lines := strings.Split(help, "\n")
	start := slices.IndexFunc(lines, func(line string) bool { return strings.HasPrefix(strings.TrimLeft(line, " \t"), flag) })
	if start == -1 {
		return ""
	}
	indent := func(line string) int { return len(line) - len(strings.TrimLeft(line, " \t")) }
	entry := []string{strings.TrimSpace(lines[start])}
	for _, line := range lines[start+1:] {
		if indent(line) <= indent(lines[start]) || strings.HasPrefix(strings.TrimLeft(line, " \t"), "-") {
			break
		}
		entry = append(entry, strings.TrimSpace(line))
	}
	return strings.Join(entry, " ")
}

var (
	quotedAlias   = regexp.MustCompile(`'([a-z0-9][a-z0-9._-]*)'`)
	listed        = regexp.MustCompile(`\(([^)]*)\)`)
	choices       = regexp.MustCompile(`\(choices:([^)]*)\)`)
	quotedChoices = regexp.MustCompile(`"([A-Za-z]+)"`)
)

// aliasesOf are the aliases --help names for --model, quoted, such as 'opus'.
func aliasesOf(help string) []string {
	var aliases []string
	for _, match := range quotedAlias.FindAllStringSubmatch(entryOf(help, "--model <model>"), -1) {
		aliases = append(aliases, match[1])
	}
	return aliases
}

// effortLevelsOf are the levels `--effort <level> ... (low, medium, high)` names in --help, each a value name.
func effortLevelsOf(help string) []string {
	var levels []string
	if match := listed.FindStringSubmatch(entryOf(help, "--effort <level>")); match != nil {
		for _, level := range strings.Split(match[1], ",") {
			if level = strings.TrimSpace(level); detection.IsName(level) {
				levels = append(levels, level)
			}
		}
	}
	return levels
}

// permissionModesOf are the modes `--permission-mode <mode> ... (choices: "acceptEdits", ...)` lists in --help (#517).
func permissionModesOf(help string) []string {
	var modes []string
	if match := choices.FindStringSubmatch(entryOf(help, "--permission-mode <mode>")); match != nil {
		for _, mode := range quotedChoices.FindAllStringSubmatch(match[1], -1) {
			modes = append(modes, mode[1])
		}
	}
	return modes
}

// knownAliases are the families probed whether --help names them or not: its --model help gives only examples (#308).
var knownAliases = []string{"fable", "opus", "sonnet", "haiku"}

// Detect reads --help and probes each alias it names and each known family it does not.
func (d Detector) Detect(ctx context.Context, version string, previous *detection.Harness, now time.Time) (detection.Harness, bool) {
	help := ""
	if ran := d.Run(ctx, detection.Command{Program: d.program(), Args: []string{"--help"}, Timeout: quickTimeout}); ran.Status == 0 {
		help = ran.Stdout
	}
	named := aliasesOf(help)
	aliases := slices.Clone(named)
	for _, alias := range knownAliases {
		if !slices.Contains(named, alias) {
			aliases = append(aliases, alias)
		}
	}
	var before *detection.Harness
	if previous != nil && previous.Version == version {
		before = previous
	}
	var resolvedBefore []string
	if before != nil {
		resolvedBefore = before.Options[detection.ModelOption].Names()
	}
	folder, err := d.NeutralFolder()
	if err != nil {
		// With no folder to probe from, nothing is detected: what was detected before stays.
		return detection.Harness{}, false
	}
	defer os.RemoveAll(folder)
	var ids []string
	isAnyResolved := false
	for _, alias := range aliases {
		args := []string{"-p", "--model", alias, "--max-turns", "1", "--output-format", "json", probePrompt}
		found := outcomeOf(alias, d.Run(ctx, detection.Command{Program: d.program(), Args: args, Dir: folder, Timeout: ProbeTimeout}))
		var kept []string
		switch {
		case found.id != "":
			isAnyResolved = true
			kept = []string{found.id}
		case !found.isRefused:
			for _, id := range resolvedBefore {
				if strings.Contains(id, alias) {
					kept = append(kept, id)
				}
			}
		}
		for _, id := range kept {
			if !slices.Contains(ids, id) {
				ids = append(ids, id)
			}
		}
	}
	found := detection.Harness{Version: version, DetectedAt: detection.Timestamp(now), Options: map[string]config.Option{}}
	switch {
	case isAnyResolved:
		confirmed := detection.Timestamp(now)
		found.ConfirmedAt = &confirmed
	case before != nil:
		found.ConfirmedAt = before.ConfirmedAt
	}
	if len(ids) > 0 {
		found.Options[detection.ModelOption] = detection.OptionOf(ids, "--model")
	}
	if levels := effortLevelsOf(help); len(levels) > 0 {
		found.Options["effort"] = detection.OptionOf(levels, "--effort")
	}
	found.PermissionModes = permissionModesOf(help)
	if len(named) == 0 && len(ids) == 0 {
		found.Problem = fmt.Sprintf("Claude Code %s's --help names no model alias, so this machine declares no Claude Code model until an update of Claude Code names one", version)
	}
	return found, true
}
