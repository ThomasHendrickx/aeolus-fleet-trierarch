// Package cursor implements Cursor CLI's captured process and sessionEnd protocol (CC3, CC4).
package cursor

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
)

var buildPattern = regexp.MustCompile(`^\d{4}\.\d{2}\.\d{2}-[a-z0-9]+$`)
var modelLine = regexp.MustCompile(`^(\S+) - (.+)$`)

// Detector reads Cursor's version and advertised models without a paid model prompt (CC9).
type Detector struct {
	Run     detection.Runner
	Program string
}

func (d Detector) program() string {
	if d.Program != "" {
		return d.Program
	}
	return "agent"
}

// Version reads the date-and-build identifier printed by agent --version.
func (d Detector) Version(ctx context.Context) (string, bool) {
	ran := d.Run(ctx, detection.Command{Program: d.program(), Args: []string{"--version"}, Timeout: 10 * time.Second})
	version := strings.TrimSpace(ran.Stdout)
	return version, ran.Status == 0 && buildPattern.MatchString(version)
}

// Detect lists model ids and the CLI default, retaining auto when listing fails.
func (d Detector) Detect(ctx context.Context, version string, _ *detection.Harness, now time.Time) (detection.Harness, bool) {
	ran := d.Run(ctx, detection.Command{Program: d.program(), Args: []string{"models"}, Timeout: 30 * time.Second})
	var models []string
	defaultModel := "auto"
	if ran.Status == 0 {
		for _, line := range strings.Split(ran.Stdout, "\n") {
			match := modelLine.FindStringSubmatch(line)
			if len(match) != 3 || !detection.IsName(match[1]) {
				continue
			}
			if !slices.Contains(models, match[1]) {
				models = append(models, match[1])
			}
			if strings.Contains(match[2], "(default)") || strings.Contains(match[2], ", default)") {
				defaultModel = match[1]
			}
		}
	}
	isEmpty := len(models) == 0
	if !slices.Contains(models, "auto") {
		models = append(models, "auto")
	}
	option := detection.OptionOf(models, "--model")
	option.Default = defaultModel
	found := detection.Harness{Version: version, DetectedAt: detection.Timestamp(now), Options: map[string]config.Option{"model": option}}
	if isEmpty {
		found.Problem = fmt.Sprintf("Cursor %s names no model in agent models, so this machine declares auto only", version)
	}
	return found, true
}
