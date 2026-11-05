package copilot

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
)

// quickTimeout is the longest --version and the help may take: both are read offline.
const quickTimeout = 10 * time.Second

// AutoModel is the model on which Copilot picks the model per request (CC9), and starts on.
const AutoModel = "auto"

var (
	// modelSetting is the model setting's entry in `copilot help config`, up to the blank line that ends it.
	modelSetting = regexp.MustCompile("(?m)^ {2}`model`:[^\n]*\n((?: {4}- \"[^\"]+\"\n?)+)")
	listedModel  = regexp.MustCompile(`- "([^"]+)"`)
)

// Detector detects Copilot (docs/trierarch.md, "Detected options"): its version from `copilot --version`, and its models from the model setting `copilot help config` documents, offline, with auto. No model is probed: every Copilot prompt costs a premium request, so none is confirmed, and a model this login may not use is refused in its session's launch window. The default is the model Copilot's own settings name when it is declared, else auto. Copilot's effort levels differ per model, so no effort is declared.
type Detector struct {
	Run detection.Runner
	// ReadSettings is Copilot's own settings, settings.json in COPILOT_HOME or ~/.copilot; empty when there are none.
	ReadSettings func() string
	// Program is the program to run, `copilot` when empty.
	Program string
}

func (d Detector) program() string {
	if d.Program == "" {
		return "copilot"
	}
	return d.Program
}

// Version is the version the first line of --version names, as "GitHub Copilot CLI 1.0.105.".
func (d Detector) Version(ctx context.Context) (string, bool) {
	ran := d.Run(ctx, detection.Command{Program: d.program(), Args: []string{"--version"}, Timeout: quickTimeout})
	first, _, _ := strings.Cut(ran.Stdout, "\n")
	version := versionPattern.FindString(first)
	return version, ran.Status == 0 && version != ""
}

// listedModelsOf are the models the help lists for the model setting, in its order.
func listedModelsOf(ran detection.Ran) []string {
	if ran.Status != 0 {
		return nil
	}
	match := modelSetting.FindStringSubmatch(ran.Stdout)
	if match == nil {
		return nil
	}
	var models []string
	for _, model := range listedModel.FindAllStringSubmatch(match[1], -1) {
		models = append(models, model[1])
	}
	return models
}

// configuredModelOf is the model Copilot's settings name, when they are JSON naming one.
func configuredModelOf(settings string) string {
	var named struct {
		Model string `json:"model"`
	}
	if json.Unmarshal([]byte(settings), &named) != nil {
		return ""
	}
	return named.Model
}

// Detect reads the models Copilot's help names.
func (d Detector) Detect(ctx context.Context, version string, _ *detection.Harness, now time.Time) (detection.Harness, bool) {
	listed := slices.DeleteFunc(listedModelsOf(d.Run(ctx, detection.Command{Program: d.program(), Args: []string{"help", "config"}, Timeout: quickTimeout})), func(model string) bool {
		return !detection.IsName(model) || model == AutoModel
	})
	models := append(slices.Clone(listed), AutoModel)
	model := detection.OptionOf(models, "--model")
	model.Default = AutoModel
	if configured := configuredModelOf(d.ReadSettings()); slices.Contains(models, configured) {
		model.Default = configured
	}
	found := detection.Harness{Version: version, DetectedAt: detection.Timestamp(now), Options: map[string]config.Option{detection.ModelOption: model}}
	if len(listed) == 0 {
		found.Problem = fmt.Sprintf("Copilot %s names no model in copilot help config, so this machine declares auto only", version)
	}
	return found, true
}
