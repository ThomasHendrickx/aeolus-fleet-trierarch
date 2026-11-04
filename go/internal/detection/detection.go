// Package detection is what each harness offers as the trierarch detects it
// (docs/trierarch.md, "Detected options"; #365, #382): kept in
// `~/.aeolus/trierarch/detected.json` apart from the operator's
// configuration, detected at init, at each start for a harness whose version
// differs from the one detected, by hand with `aeolus-trierarch detect`, and
// after a session refused a model, never more often: a probe costs a call.
package detection

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

// ModelOption is the option that names the model: its ids come from detection only (#382).
const ModelOption = "model"

// Refused is a model id a session on the machine refused, and when.
type Refused struct {
	ID string `json:"id"`
	At string `json:"at"`
}

// Harness is what detection found of one harness: its version, when it was detected and its models last confirmed, its options, a problem to tell argo, Claude Code's permission modes and the ids sessions refused at this version.
type Harness struct {
	Version         string                   `json:"version"`
	DetectedAt      string                   `json:"detectedAt"`
	ConfirmedAt     *string                  `json:"confirmedAt"`
	Options         map[string]config.Option `json:"options"`
	Problem         string                   `json:"problem,omitempty"`
	PermissionModes []string                 `json:"permissionModes,omitempty"`
	Refused         []Refused                `json:"refused,omitempty"`
}

// Detected is what detection found, by harness.
type Detected map[string]Harness

// Detector detects one harness: the version its CLI says, then what it offers at that version, given what was detected before.
type Detector interface {
	Version(ctx context.Context) (string, bool)
	Detect(ctx context.Context, version string, previous *Harness, now time.Time) (Harness, bool)
}

// Store keeps what was detected.
type Store interface {
	Load() Detected
	Save(detected Detected) error
}

// By is why detection runs.
type By string

const (
	// ByStart detects only a harness whose version changed.
	ByStart By = "start"
	// ByHand detects every harness, clearing the ids sessions refused.
	ByHand By = "hand"
	// ByRefusal detects the harness again after a session refused a model, keeping the refused ids while its version is the same.
	ByRefusal By = "refusal"
)

// Detection detects the harnesses with their detectors and keeps what it finds.
type Detection struct {
	Detectors map[string]Detector
	Store     Store
	Now       func() time.Time
	// Warn tells the operator what detection kept as before.
	Warn func(line string)
}

// Detect detects the harnesses given that have a detector, as by says, and gives what is detected of them. A harness whose CLI does not say its version, or gives nothing to detect, keeps what was detected before.
func (d Detection) Detect(ctx context.Context, harnesses []string, by By) (Detected, error) {
	before := d.Store.Load()
	detected := maps.Clone(before)
	isChanged := false
	for _, name := range harnesses {
		detector, ok := d.Detectors[name]
		if !ok {
			continue
		}
		previous, wasDetected := before[name]
		version, ok := detector.Version(ctx)
		if !ok {
			d.Warn(name + " did not say its version, so its options stay as detected before")
			continue
		}
		if by == ByStart && wasDetected && previous.Version == version {
			continue
		}
		var given *Harness
		if wasDetected {
			given = &previous
		}
		found, ok := detector.Detect(ctx, version, given, d.Now())
		if !ok {
			d.Warn(fmt.Sprintf("%s %s gave nothing to detect, so its options stay as detected before", name, version))
			continue
		}
		found.Refused = nil
		if by == ByRefusal && wasDetected && previous.Version == version {
			found.Refused = previous.Refused
		}
		detected[name] = found
		isChanged = true
	}
	if isChanged {
		if err := d.Store.Save(detected); err != nil {
			return nil, fmt.Errorf("keep what detection found: %w", err)
		}
	}
	given := Detected{}
	for _, name := range harnesses {
		if found, ok := detected[name]; ok {
			given[name] = found
		}
	}
	return given, nil
}

// Refuse keeps a model a session refused as refused for its harness's detected version, so the machine offers it no more, and gives what is detected now. A harness detection never found has no models to refuse.
func Refuse(store Store, harness string, id string, at time.Time) (Detected, error) {
	detected := store.Load()
	found, ok := detected[harness]
	if !ok || slices.ContainsFunc(found.Refused, func(each Refused) bool { return each.ID == id }) {
		return detected, nil
	}
	found.Refused = append(slices.Clone(found.Refused), Refused{ID: id, At: Timestamp(at)})
	detected[harness] = found
	if err := store.Save(detected); err != nil {
		return nil, fmt.Errorf("keep %s refused for %s: %w", id, harness, err)
	}
	return detected, nil
}

// Timestamp is the time as today's trierarch writes one: UTC to the millisecond.
func Timestamp(at time.Time) string {
	return at.UTC().Format("2006-01-02T15:04:05.000Z")
}

// OptionOf is an option of the names given, in their order, each adding the flag and its name.
func OptionOf(names []string, flag string) config.Option {
	values := map[string][]string{}
	for _, name := range names {
		values[name] = []string{flag, name}
	}
	return config.Option{Values: values, Order: slices.Clone(names)}
}

// offeredModel is the detected model option without the ids the machine refused, its default moved to the first id left; none when none is left.
func offeredModel(found Harness) (config.Option, bool) {
	model, ok := found.Options[ModelOption]
	if !ok {
		return config.Option{}, false
	}
	offered := config.Option{Values: map[string][]string{}}
	for _, id := range model.Names() {
		if !slices.ContainsFunc(found.Refused, func(each Refused) bool { return each.ID == id }) {
			offered.Values[id] = model.Values[id]
			offered.Order = append(offered.Order, id)
		}
	}
	if len(offered.Order) == 0 {
		return config.Option{}, false
	}
	if model.Default != "" {
		offered.Default = offered.Order[0]
		if _, isLeft := offered.Values[model.Default]; isLeft {
			offered.Default = model.Default
		}
	}
	return offered, true
}

// Offered is the configuration with each configured harness's detected options added: an option the operator wrote replaces the detected one of its name whole, values and default, so a hand edit is never overwritten. The model is the exception: its ids come from detection only, without the ids the machine refused, so a model the operator wrote is ignored. A detected harness the configuration does not offer is left out.
func Offered(configuration config.Configuration, detected Detected) config.Configuration {
	harnesses := map[string]config.Harness{}
	for name, harness := range configuration.Harnesses {
		options := map[string]config.Option{}
		if found, ok := detected[name]; ok {
			maps.Copy(options, found.Options)
			delete(options, ModelOption)
			if model, ok := offeredModel(found); ok {
				options[ModelOption] = model
			}
		}
		for option, written := range harness.Options {
			if option != ModelOption {
				options[option] = written
			}
		}
		harness.Options = options
		harnesses[name] = harness
	}
	configuration.Harnesses = harnesses
	return configuration
}

// ModelOptionsIgnored are the harnesses whose configuration writes a model option, which is ignored (#382).
func ModelOptionsIgnored(configuration config.Configuration) []string {
	var ignored []string
	for _, name := range slices.Sorted(maps.Keys(configuration.Harnesses)) {
		if _, ok := configuration.Harnesses[name].Options[ModelOption]; ok {
			ignored = append(ignored, name)
		}
	}
	return ignored
}

// optionNames are the option names in the order detection gives them: the model first, then the others by name.
func optionNames(options map[string]config.Option) []string {
	names := slices.Sorted(maps.Keys(options))
	if at := slices.Index(names, ModelOption); at > 0 {
		names = append([]string{ModelOption}, slices.Delete(names, at, at+1)...)
	}
	return names
}

// Describe says a line per harness: its version, each option with its values and default, when its models were last confirmed, and the ids the machine refused.
func Describe(harnesses []string, detected Detected) string {
	lines := []string{}
	for _, name := range harnesses {
		found, ok := detected[name]
		if !ok {
			lines = append(lines, name+": nothing detected")
			continue
		}
		options := []string{}
		for _, option := range optionNames(found.Options) {
			settings := found.Options[option]
			values := []string{}
			for _, value := range settings.Names() {
				if value == settings.Default {
					value += " (default)"
				}
				values = append(values, value)
			}
			options = append(options, option+" "+strings.Join(values, ", "))
		}
		said := "no options detected"
		if len(options) > 0 {
			said = strings.Join(options, "; ")
		}
		confirmed := "no model confirmed"
		if found.ConfirmedAt != nil {
			confirmed = "models confirmed " + *found.ConfirmedAt
		}
		refused := ""
		if len(found.Refused) > 0 {
			ids := []string{}
			for _, each := range found.Refused {
				ids = append(ids, each.ID)
			}
			refused = "; refused " + strings.Join(ids, ", ")
		}
		lines = append(lines, fmt.Sprintf("%s %s: %s; %s%s", name, found.Version, said, confirmed, refused))
	}
	return strings.Join(lines, "\n")
}

// HarnessReport is what `aeolus-trierarch detect --json` gives of a harness: its version, when its models were last confirmed, and each option's value names.
type HarnessReport struct {
	Version     string              `json:"version"`
	ConfirmedAt *string             `json:"confirmedAt"`
	Options     map[string][]string `json:"options"`
}

// ReportOf is what detect gives of what was detected, by harness.
func ReportOf(detected Detected) map[string]HarnessReport {
	report := map[string]HarnessReport{}
	for name, found := range detected {
		options := map[string][]string{}
		for option, settings := range found.Options {
			options[option] = settings.Names()
		}
		report[name] = HarnessReport{Version: found.Version, ConfirmedAt: found.ConfirmedAt, Options: options}
	}
	return report
}
