package codex

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
)

// ProbeTimeout is the longest a probe may take: a CLI that hangs is ended, its model neither confirmed nor refused.
const ProbeTimeout = time.Minute

// quickTimeout is the longest --version and the catalog may take: both are read offline.
const quickTimeout = 10 * time.Second

const probePrompt = "Reply OK"

// visible is the catalog's way of marking a model the picker shows.
const visible = "list"

// refusals are how Codex says this login may not use a model, as codex-cli 0.160.1 answers it.
var refusals = []string{"invalid_request_error", "model is not supported"}

// Detector detects Codex (#365; docs/trierarch.md, "Detected options"): its own catalog names its models, the one it runs with now (`codex debug models`), else the bundled one (`--bundled`), offline. The catalog says what Codex knows, not what this login may use (#392): each of its models, hidden ones included, is probed once with a short non-interactive turn, from a neutral folder and never as a ship, and only the ones it confirms are declared, each with `-m`. A model whose probe neither confirms nor refuses it (offline, timed out) keeps what was confirmed before at the same version. The default is the model the top level of Codex's config.toml sets when confirmed, else the first confirmed model the catalog shows; none without one. Codex has no effort flag, so no effort is declared.
type Detector struct {
	Run detection.Runner
	// ReadConfig is Codex's configuration, config.toml in CODEX_HOME or ~/.codex; empty when there is none.
	ReadConfig func() string
	// NeutralFolder is a new empty folder to probe from, so no project's instructions or settings apply.
	NeutralFolder func() (string, error)
	// Program is the program to run, `codex` when empty.
	Program string
}

func (d Detector) program() string {
	if d.Program == "" {
		return "codex"
	}
	return d.Program
}

// Version is the version the last word of --version says.
func (d Detector) Version(ctx context.Context) (string, bool) {
	ran := d.Run(ctx, detection.Command{Program: d.program(), Args: []string{"--version"}, Timeout: quickTimeout})
	words := strings.Fields(ran.Stdout)
	if ran.Status != 0 || len(words) == 0 {
		return "", false
	}
	return words[len(words)-1], true
}

type catalogModel struct {
	Slug       string `json:"slug"`
	Visibility string `json:"visibility"`
}

// catalogOf are the models of the catalog Codex answered; none when it answered none.
func catalogOf(ran detection.Ran) ([]catalogModel, bool) {
	var catalog struct {
		Models []catalogModel `json:"models"`
	}
	if ran.Status != 0 || json.Unmarshal([]byte(ran.Stdout), &catalog) != nil || catalog.Models == nil {
		return nil, false
	}
	return catalog.Models, true
}

// probeOutcome is what a probe of a model found: confirmed, refused, or neither.
type probeOutcome int

const (
	probeUnknown probeOutcome = iota
	probeConfirmed
	probeRefused
)

func probeOutcomeOf(ran detection.Ran) probeOutcome {
	said := ran.Stdout + "\n" + ran.Stderr
	if slices.ContainsFunc(refusals, func(refusal string) bool { return strings.Contains(said, refusal) }) {
		return probeRefused
	}
	if ran.Status == 0 {
		return probeConfirmed
	}
	return probeUnknown
}

var (
	firstTable      = regexp.MustCompile(`(?m)^\s*\[`)
	configuredModel = regexp.MustCompile(`(?m)^\s*model\s*=\s*"([^"]+)"`)
)

// configuredModelOf is the `model = "..."` of the configuration's top level, before its first table.
func configuredModelOf(text string) string {
	if at := firstTable.FindStringIndex(text); at != nil {
		text = text[:at[0]]
	}
	if match := configuredModel.FindStringSubmatch(text); match != nil {
		return match[1]
	}
	return ""
}

// Detect reads the catalog and probes each of its models.
func (d Detector) Detect(ctx context.Context, version string, previous *detection.Harness, now time.Time) (detection.Harness, bool) {
	catalog, ok := catalogOf(d.Run(ctx, detection.Command{Program: d.program(), Args: []string{"debug", "models"}, Timeout: quickTimeout}))
	if !ok {
		catalog, _ = catalogOf(d.Run(ctx, detection.Command{Program: d.program(), Args: []string{"debug", "models", "--bundled"}, Timeout: quickTimeout}))
	}
	models := slices.DeleteFunc(catalog, func(model catalogModel) bool { return !detection.IsName(model.Slug) })
	if len(models) == 0 {
		return detection.Harness{}, false
	}
	var before *detection.Harness
	if previous != nil && previous.Version == version {
		before = previous
	}
	var confirmedBefore []string
	if before != nil {
		confirmedBefore = before.Options[detection.ModelOption].Names()
	}
	folder, err := d.NeutralFolder()
	if err != nil {
		// With no folder to probe from, nothing is detected: what was detected before stays.
		return detection.Harness{}, false
	}
	defer os.RemoveAll(folder)
	var confirmed []string
	isAnyConfirmed := false
	for _, model := range models {
		args := []string{"exec", "--skip-git-repo-check", "-m", model.Slug, probePrompt}
		switch probeOutcomeOf(d.Run(ctx, detection.Command{Program: d.program(), Args: args, Dir: folder, Timeout: ProbeTimeout})) {
		case probeConfirmed:
			isAnyConfirmed = true
			confirmed = append(confirmed, model.Slug)
		case probeUnknown:
			if slices.Contains(confirmedBefore, model.Slug) {
				confirmed = append(confirmed, model.Slug)
			}
		}
	}
	found := detection.Harness{Version: version, DetectedAt: detection.Timestamp(now), Options: map[string]config.Option{}}
	switch {
	case isAnyConfirmed:
		at := detection.Timestamp(now)
		found.ConfirmedAt = &at
	case before != nil:
		found.ConfirmedAt = before.ConfirmedAt
	}
	if len(confirmed) == 0 {
		found.Problem = fmt.Sprintf("Codex %s confirmed none of its catalog's models for this login, so this machine declares no Codex model", version)
		return found, true
	}
	model := detection.OptionOf(confirmed, "-m")
	if configured := configuredModelOf(d.ReadConfig()); slices.Contains(confirmed, configured) {
		model.Default = configured
	} else if at := slices.IndexFunc(models, func(each catalogModel) bool {
		return each.Visibility == visible && slices.Contains(confirmed, each.Slug)
	}); at >= 0 {
		model.Default = models[at].Slug
	}
	found.Options[detection.ModelOption] = model
	return found, true
}
