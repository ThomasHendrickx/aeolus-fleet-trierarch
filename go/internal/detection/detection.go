// Package detection is what each harness offers as the trierarch detects it
// (docs/trierarch.md, "Detected options"; #365, #382): kept in
// `~/.aeolus/trierarch/detected.json` apart from the operator's
// configuration, detected at init, at each start for a harness whose version
// differs from the one detected, by hand with `aeolus-trierarch detect`, after
// a session refused a model, once a day while the trierarch runs, and before a
// request for a model no harness lists is given back (#333), never more
// often: a probe costs a call.
package detection

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

// ModelOption is the option that names the model: its ids come from detection only (#382).
const ModelOption = config.ModelOption

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
	// ByAge detects a harness last detected ConfirmEvery ago or more, also at the same version, as a vendor adds models to a harness without a new version (#333). It keeps the refused ids like ByRefusal.
	ByAge By = "age"
	// ByRequest detects the harness again before a request for a model it does not list is given back (#333), at the same version too, keeping the refused ids like ByRefusal.
	ByRequest By = "request"
)

// ConfirmEvery is how long a harness's models stand before they are confirmed again.
const ConfirmEvery = 24 * time.Hour

// isDue is whether the harness was last detected ConfirmEvery ago or more; one whose time cannot be read is due.
func isDue(found Harness, at time.Time) bool {
	detectedAt, err := time.Parse(time.RFC3339, found.DetectedAt)
	return err != nil || at.Sub(detectedAt) >= ConfirmEvery
}

// keepsRefused is whether the ids a session refused stay while the harness is detected again at the same version.
func (by By) keepsRefused() bool {
	return by == ByRefusal || by == ByAge || by == ByRequest
}

// keeping serialises each load, change and save of the detected file in this process: a refusal and a detection finishing together each keep the other's change.
var keeping sync.Mutex

// Detection detects the harnesses with their detectors and keeps what it finds.
type Detection struct {
	Detectors map[string]Detector
	Store     Store
	Now       func() time.Time
	// Warn tells the operator what detection kept as before.
	Warn func(line string)
	// Given is told what is detected after each save, while no other save can come between, so what it is told never goes back to before a later save (#333). None tells nothing.
	Given func(Detected)
}

// Detect detects the harnesses given that have a detector, as by says, and gives what is detected of them. A harness whose CLI does not say its version, or gives nothing to detect, keeps what was detected before.
func (d Detection) Detect(ctx context.Context, harnesses []string, by By) (Detected, error) {
	before := d.Store.Load()
	found := Detected{}
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
		if by == ByAge && wasDetected && previous.Version == version && !isDue(previous, d.Now()) {
			continue
		}
		var given *Harness
		if wasDetected {
			given = &previous
		}
		harness, ok := detector.Detect(ctx, version, given, d.Now())
		if !ok {
			d.Warn(fmt.Sprintf("%s %s gave nothing to detect, so its options stay as detected before", name, version))
			continue
		}
		found[name] = harness
	}
	detected, err := d.keep(found, by)
	if err != nil {
		return nil, err
	}
	given := Detected{}
	for _, name := range harnesses {
		if found, ok := detected[name]; ok {
			given[name] = found
		}
	}
	return given, nil
}

// keep saves what was found onto what is kept now, not onto what was kept when the probes began: a model refused while they ran stays refused, as Refuse does under the same lock, and what a probe begun later kept stays (#333).
func (d Detection) keep(found Detected, by By) (Detected, error) {
	keeping.Lock()
	defer keeping.Unlock()
	detected := d.Store.Load()
	for name, harness := range found {
		if kept, ok := detected[name]; ok && isLater(kept.DetectedAt, harness.DetectedAt) {
			continue
		}
		harness.Refused = nil
		if kept, ok := detected[name]; by.keepsRefused() && ok && kept.Version == harness.Version {
			harness.Refused = kept.Refused
		}
		detected[name] = harness
	}
	if len(found) > 0 {
		if err := d.Store.Save(detected); err != nil {
			return nil, fmt.Errorf("keep what detection found: %w", err)
		}
		d.give(detected)
	}
	return detected, nil
}

// give tells Given what is detected; asked under the lock each save is made under.
func (d Detection) give(detected Detected) {
	if d.Given != nil {
		d.Given(detected)
	}
}

// isLater is whether the time kept is after the time found; one that cannot be read is not.
func isLater(kept string, found string) bool {
	keptAt, err := time.Parse(time.RFC3339, kept)
	if err != nil {
		return false
	}
	foundAt, err := time.Parse(time.RFC3339, found)
	return err == nil && keptAt.After(foundAt)
}

// Refuse keeps a model a session refused as refused for its harness's detected version, so the machine offers it no more, and gives what is detected now. A harness detection never found has no models to refuse.
func Refuse(store Store, harness string, id string, at time.Time) (Detected, error) {
	return refuse(store, harness, id, at, func(Detected) {})
}

// refuse keeps the model refused and tells given what is detected then, under the same lock.
func refuse(store Store, harness string, id string, at time.Time, given func(Detected)) (Detected, error) {
	keeping.Lock()
	defer keeping.Unlock()
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
	given(detected)
	return detected, nil
}

// Refuse keeps a model a session refused as refused and tells Given what is detected now at once, so the next pass offers it no more. Then it detects the harness again in the background, keeping the id refused, and Given is told what that finds too: the loop never waits on a probe. A harness detection never found has no models to refuse, so nothing is given and nothing is detected.
func (d Detection) Refuse(ctx context.Context, harness string, id string, at time.Time) error {
	if _, ok := d.Store.Load()[harness]; !ok {
		return nil
	}
	if _, err := refuse(d.Store, harness, id, at, d.give); err != nil {
		return err
	}
	go func() {
		if _, err := d.Detect(ctx, []string{harness}, ByRefusal); err != nil {
			d.Warn(fmt.Sprintf("%s could not be detected again after it refused %s: %v", harness, id, err))
		}
	}()
	return nil
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
	return config.Harness{Options: options}.OptionNames()
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

// Due are the harnesses given, each with a detector, that detection never found or last found ConfirmEvery ago or more, and that were not tried, by when tried says, within ConfirmEvery: a detection that fails keeps the time it was last found, so it is tried again once a day, not each pass. Each named is counted tried now in tried.
func (d Detection) Due(harnesses []string, tried map[string]time.Time) []string {
	detected := d.Store.Load()
	now := d.Now()
	due := []string{}
	for _, name := range harnesses {
		if d.Detectors[name] == nil {
			continue
		}
		if found, ok := detected[name]; ok && !isDue(found, now) {
			continue
		}
		if at, ok := tried[name]; ok && now.Sub(at) < ConfirmEvery {
			continue
		}
		tried[name] = now
		due = append(due, name)
	}
	return due
}
