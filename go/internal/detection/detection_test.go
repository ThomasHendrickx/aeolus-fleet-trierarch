package detection

import (
	"context"
	"maps"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

var (
	now     = time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC)
	earlier = time.Date(2026, 11, 1, 9, 30, 0, 0, time.UTC)
)

// aStore is the detected file in memory.
type aStore struct {
	detected Detected
	saves    int
}

func (s *aStore) Load() Detected {
	return clone(s.detected)
}

func (s *aStore) Save(detected Detected) error {
	s.detected, s.saves = clone(detected), s.saves+1
	return nil
}

func clone(detected Detected) Detected {
	cloned := Detected{}
	for name, found := range detected {
		cloned[name] = found
	}
	return cloned
}

// aDetector says a version and finds what it is given, counting its detections.
type aDetector struct {
	version    string
	found      *Harness
	detections int
	previous   *Harness
	during     func()
}

func (d *aDetector) Version(context.Context) (string, bool) {
	return d.version, d.version != ""
}

func (d *aDetector) Detect(_ context.Context, version string, previous *Harness, at time.Time) (Harness, bool) {
	d.detections++
	d.previous = previous
	if d.during != nil {
		d.during()
	}
	if d.found == nil {
		return Harness{}, false
	}
	found := *d.found
	found.Version, found.DetectedAt = version, Timestamp(at)
	return found, true
}

func aHarness(version string, models ...string) Harness {
	return Harness{Version: version, DetectedAt: Timestamp(earlier), Options: map[string]config.Option{ModelOption: OptionOf(models, "--model")}}
}

func aDetection(store *aStore, detectors map[string]Detector) (Detection, *[]string) {
	warned := &[]string{}
	return Detection{Detectors: detectors, Store: store, Now: func() time.Time { return now }, Warn: func(line string) { *warned = append(*warned, line) }}, warned
}

func TestAStartDetectsAHarnessDetectedNever(t *testing.T) {
	found := aHarness("", "claude-opus-5")
	detector := &aDetector{version: "2.1.306", found: &found}
	store := &aStore{detected: Detected{}}
	detection, _ := aDetection(store, map[string]Detector{"claude-code": detector})

	detected, err := detection.Detect(context.Background(), []string{"claude-code"}, ByStart)

	if err != nil {
		t.Fatal(err)
	}
	if got := detected["claude-code"]; got.Version != "2.1.306" || got.DetectedAt != "2026-11-04T10:00:00.000Z" {
		t.Errorf("Detect() = %+v, want claude-code 2.1.306 detected at 2026-11-04T10:00:00.000Z", got)
	}
	if store.detected["claude-code"].Version != "2.1.306" {
		t.Errorf("saved %+v, want claude-code 2.1.306", store.detected)
	}
}

func TestAStartDetectsNoHarnessWhoseVersionIsTheOneDetected(t *testing.T) {
	found := aHarness("", "claude-opus-5")
	detector := &aDetector{version: "2.1.306", found: &found}
	store := &aStore{detected: Detected{"claude-code": aHarness("2.1.306", "claude-sonnet-5")}}
	detection, _ := aDetection(store, map[string]Detector{"claude-code": detector})

	detected, _ := detection.Detect(context.Background(), []string{"claude-code"}, ByStart)

	if detector.detections != 0 || store.saves != 0 {
		t.Errorf("detections, saves = %d, %d, want 0, 0", detector.detections, store.saves)
	}
	if got := detected["claude-code"].Options[ModelOption].Names(); !slices.Equal(got, []string{"claude-sonnet-5"}) {
		t.Errorf("models = %v, want those detected before", got)
	}
}

func TestAStartDetectsAgainAHarnessWhoseVersionDiffers(t *testing.T) {
	found := aHarness("", "claude-opus-5")
	detector := &aDetector{version: "2.1.306", found: &found}
	before := aHarness("2.1.0", "claude-sonnet-5")
	store := &aStore{detected: Detected{"claude-code": before}}
	detection, _ := aDetection(store, map[string]Detector{"claude-code": detector})

	detected, _ := detection.Detect(context.Background(), []string{"claude-code"}, ByStart)

	if got := detected["claude-code"].Version; got != "2.1.306" {
		t.Errorf("version = %s, want 2.1.306", got)
	}
	if detector.previous == nil || detector.previous.Version != "2.1.0" {
		t.Errorf("previous = %+v, want the detection of 2.1.0", detector.previous)
	}
}

func TestAHarnessThatSaysNoVersionKeepsWhatWasDetectedBefore(t *testing.T) {
	detector := &aDetector{}
	store := &aStore{detected: Detected{"claude-code": aHarness("2.1.0", "claude-sonnet-5")}}
	detection, warned := aDetection(store, map[string]Detector{"claude-code": detector})

	detected, _ := detection.Detect(context.Background(), []string{"claude-code"}, ByHand)

	if detected["claude-code"].Version != "2.1.0" || detector.detections != 0 {
		t.Errorf("Detect() = %+v after %d detections, want 2.1.0 kept and no detection", detected["claude-code"], detector.detections)
	}
	if want := []string{"claude-code did not say its version, so its options stay as detected before"}; !slices.Equal(*warned, want) {
		t.Errorf("warned %v, want %v", *warned, want)
	}
}

func TestAHarnessThatGivesNothingToDetectKeepsWhatWasDetectedBefore(t *testing.T) {
	detector := &aDetector{version: "0.163.0"}
	store := &aStore{detected: Detected{"codex": aHarness("0.160.1", "gpt-5.6-terra")}}
	detection, warned := aDetection(store, map[string]Detector{"codex": detector})

	detected, _ := detection.Detect(context.Background(), []string{"codex"}, ByStart)

	if detected["codex"].Version != "0.160.1" || store.saves != 0 {
		t.Errorf("Detect() = %+v after %d saves, want 0.160.1 kept and nothing saved", detected["codex"], store.saves)
	}
	if want := []string{"codex 0.163.0 gave nothing to detect, so its options stay as detected before"}; !slices.Equal(*warned, want) {
		t.Errorf("warned %v, want %v", *warned, want)
	}
}

func TestDetectingByHandDetectsAgainAtTheSameVersionAndClearsTheRefusedIDs(t *testing.T) {
	found := aHarness("", "claude-sonnet-5", "claude-opus-5")
	detector := &aDetector{version: "2.1.306", found: &found}
	before := aHarness("2.1.306", "claude-sonnet-5", "claude-opus-5")
	before.Refused = []Refused{{ID: "claude-sonnet-5", At: Timestamp(earlier)}}
	store := &aStore{detected: Detected{"claude-code": before}}
	detection, _ := aDetection(store, map[string]Detector{"claude-code": detector})

	detected, _ := detection.Detect(context.Background(), []string{"claude-code"}, ByHand)

	if detector.detections != 1 || len(detected["claude-code"].Refused) != 0 {
		t.Errorf("Detect() = %+v after %d detections, want one detection and no refused id", detected["claude-code"], detector.detections)
	}
}

func TestDetectingAfterARefusalKeepsTheRefusedIDsAtTheSameVersion(t *testing.T) {
	found := aHarness("", "claude-sonnet-5", "claude-opus-5")
	detector := &aDetector{version: "2.1.306", found: &found}
	before := aHarness("2.1.306", "claude-sonnet-5", "claude-opus-5")
	before.Refused = []Refused{{ID: "claude-sonnet-5", At: Timestamp(earlier)}}
	store := &aStore{detected: Detected{"claude-code": before}}
	detection, _ := aDetection(store, map[string]Detector{"claude-code": detector})

	detected, _ := detection.Detect(context.Background(), []string{"claude-code"}, ByRefusal)

	if got, want := detected["claude-code"].Refused, before.Refused; !reflect.DeepEqual(got, want) {
		t.Errorf("refused = %v, want %v", got, want)
	}
}

func TestRefusalsSavedWhileTheProbeRunsAreKeptWhenDetectionSaves(t *testing.T) {
	found := aHarness("", "claude-sonnet-5", "claude-opus-5", "claude-haiku-5")
	before := aHarness("2.1.306", "claude-sonnet-5", "claude-opus-5", "claude-haiku-5")
	before.Refused = []Refused{{ID: "claude-sonnet-5", At: Timestamp(earlier)}}
	store := &aStore{detected: Detected{"claude-code": before}}
	detector := &aDetector{version: "2.1.306", found: &found}
	detector.during = func() {
		_, _ = Refuse(store, "claude-code", "claude-opus-5", now)
		_, _ = Refuse(store, "claude-code", "claude-haiku-5", now)
	}
	detection, _ := aDetection(store, map[string]Detector{"claude-code": detector})

	detected, _ := detection.Detect(context.Background(), []string{"claude-code"}, ByRefusal)

	want := []string{"claude-sonnet-5", "claude-opus-5", "claude-haiku-5"}
	for name, got := range map[string]Detected{"saved": store.detected, "given": detected} {
		var ids []string
		for _, each := range got["claude-code"].Refused {
			ids = append(ids, each.ID)
		}
		if !slices.Equal(ids, want) {
			t.Errorf("%s refused = %v, want %v", name, ids, want)
		}
	}
}

func TestDetectingAfterARefusalDropsTheRefusedIDsOfAnotherVersion(t *testing.T) {
	found := aHarness("", "claude-sonnet-5")
	detector := &aDetector{version: "2.1.306", found: &found}
	before := aHarness("2.1.0", "claude-sonnet-5")
	before.Refused = []Refused{{ID: "claude-sonnet-5", At: Timestamp(earlier)}}
	store := &aStore{detected: Detected{"claude-code": before}}
	detection, _ := aDetection(store, map[string]Detector{"claude-code": detector})

	detected, _ := detection.Detect(context.Background(), []string{"claude-code"}, ByRefusal)

	if got := detected["claude-code"].Refused; len(got) != 0 {
		t.Errorf("refused = %v, want none", got)
	}
}

func TestDetectionGivesTheHarnessesAskedAndKeepsTheOthersSaved(t *testing.T) {
	found := aHarness("", "claude-opus-5")
	store := &aStore{detected: Detected{"codex": aHarness("0.163.0", "gpt-5.6-terra")}}
	detection, _ := aDetection(store, map[string]Detector{"claude-code": &aDetector{version: "2.1.306", found: &found}, "codex": &aDetector{version: "0.163.0"}})

	detected, _ := detection.Detect(context.Background(), []string{"claude-code", "cursor"}, ByStart)

	if got := slices.Sorted(maps.Keys(detected)); !slices.Equal(got, []string{"claude-code"}) {
		t.Errorf("Detect() gives %v, want claude-code alone", got)
	}
	if _, ok := store.detected["codex"]; !ok {
		t.Errorf("saved %v, want codex kept", store.detected)
	}
}

func TestARefusedModelIsKeptRefusedForTheVersionDetected(t *testing.T) {
	store := &aStore{detected: Detected{"claude-code": aHarness("2.1.306", "claude-sonnet-5", "claude-opus-5")}}

	detected, err := Refuse(store, "claude-code", "claude-sonnet-5", now)

	if err != nil {
		t.Fatal(err)
	}
	want := []Refused{{ID: "claude-sonnet-5", At: "2026-11-04T10:00:00.000Z"}}
	if got := store.detected["claude-code"].Refused; !reflect.DeepEqual(got, want) {
		t.Errorf("saved refused = %v, want %v", got, want)
	}
	if got := detected["claude-code"].Refused; !reflect.DeepEqual(got, want) {
		t.Errorf("Refuse() refused = %v, want %v", got, want)
	}
}

func TestAModelRefusedTwiceIsKeptOnce(t *testing.T) {
	store := &aStore{detected: Detected{"claude-code": aHarness("2.1.306", "claude-sonnet-5")}}
	_, _ = Refuse(store, "claude-code", "claude-sonnet-5", earlier)

	_, _ = Refuse(store, "claude-code", "claude-sonnet-5", now)

	if got := store.detected["claude-code"].Refused; len(got) != 1 || store.saves != 1 {
		t.Errorf("refused = %v after %d saves, want one id, saved once", got, store.saves)
	}
}

func TestAHarnessDetectionNeverFoundHasNoModelToRefuse(t *testing.T) {
	store := &aStore{detected: Detected{}}

	detected, _ := Refuse(store, "claude-code", "claude-sonnet-5", now)

	if len(detected) != 0 || store.saves != 0 {
		t.Errorf("Refuse() = %v after %d saves, want nothing", detected, store.saves)
	}
}

func aConfiguration(harnesses map[string]config.Harness) config.Configuration {
	configuration := config.Initial()
	configuration.Harnesses = harnesses
	return configuration
}

func TestTheConfigurationOffersTheDetectedOptions(t *testing.T) {
	found := aHarness("2.1.306", "claude-sonnet-5", "claude-opus-5")
	found.Options["effort"] = OptionOf([]string{"low", "high"}, "--effort")
	configuration := aConfiguration(map[string]config.Harness{"claude-code": {Flags: []string{}, Options: map[string]config.Option{}}})

	offered := Offered(configuration, Detected{"claude-code": found})

	options := offered.Harnesses["claude-code"].Options
	if got := options[ModelOption].Names(); !slices.Equal(got, []string{"claude-sonnet-5", "claude-opus-5"}) {
		t.Errorf("models = %v, want claude-sonnet-5, claude-opus-5", got)
	}
	if got := options["effort"].Values["high"]; !slices.Equal(got, []string{"--effort", "high"}) {
		t.Errorf("effort high = %v, want --effort high", got)
	}
}

func TestAnOptionTheOperatorWroteReplacesTheDetectedOneWhole(t *testing.T) {
	found := aHarness("2.1.306", "claude-opus-5")
	found.Options["effort"] = OptionOf([]string{"low", "high"}, "--effort")
	written := config.Option{Values: map[string][]string{"max": {"--effort", "max"}}, Default: "max"}
	configuration := aConfiguration(map[string]config.Harness{"claude-code": {Flags: []string{}, Options: map[string]config.Option{"effort": written}}})

	offered := Offered(configuration, Detected{"claude-code": found})

	if got := offered.Harnesses["claude-code"].Options["effort"]; !reflect.DeepEqual(got, written) {
		t.Errorf("effort = %+v, want %+v", got, written)
	}
}

func TestAModelOptionTheOperatorWroteIsIgnored(t *testing.T) {
	found := aHarness("2.1.306", "claude-opus-5")
	written := config.Option{Values: map[string][]string{"opus": {"--model", "opus"}}}
	configuration := aConfiguration(map[string]config.Harness{"claude-code": {Flags: []string{}, Options: map[string]config.Option{ModelOption: written}}})

	offered := Offered(configuration, Detected{"claude-code": found})

	if got := offered.Harnesses["claude-code"].Options[ModelOption].Names(); !slices.Equal(got, []string{"claude-opus-5"}) {
		t.Errorf("models = %v, want the detected claude-opus-5", got)
	}
	if got := ModelOptionsIgnored(configuration); !slices.Equal(got, []string{"claude-code"}) {
		t.Errorf("ModelOptionsIgnored() = %v, want claude-code", got)
	}
}

func TestARefusedModelIsOfferedNoMoreAndTheDefaultMovesToTheFirstLeft(t *testing.T) {
	found := Harness{Version: "0.163.0", Options: map[string]config.Option{ModelOption: withDefault(OptionOf([]string{"gpt-5.6-terra", "gpt-5.5", "gpt-5.4"}, "-m"), "gpt-5.6-terra")}}
	found.Refused = []Refused{{ID: "gpt-5.6-terra", At: Timestamp(earlier)}}
	configuration := aConfiguration(map[string]config.Harness{"codex": {Flags: []string{}, Options: map[string]config.Option{}}})

	model := Offered(configuration, Detected{"codex": found}).Harnesses["codex"].Options[ModelOption]

	if !slices.Equal(model.Names(), []string{"gpt-5.5", "gpt-5.4"}) || model.Default != "gpt-5.5" {
		t.Errorf("model = %v default %s, want gpt-5.5, gpt-5.4 default gpt-5.5", model.Names(), model.Default)
	}
}

func TestAModelWithNoDefaultHasNoneOnceOneIsRefused(t *testing.T) {
	found := aHarness("2.1.306", "claude-sonnet-5", "claude-opus-5")
	found.Refused = []Refused{{ID: "claude-sonnet-5", At: Timestamp(earlier)}}
	configuration := aConfiguration(map[string]config.Harness{"claude-code": {Flags: []string{}, Options: map[string]config.Option{}}})

	model := Offered(configuration, Detected{"claude-code": found}).Harnesses["claude-code"].Options[ModelOption]

	if model.Default != "" {
		t.Errorf("default = %s, want none", model.Default)
	}
}

func TestAHarnessWithEveryModelRefusedOffersNoModel(t *testing.T) {
	found := aHarness("2.1.306", "claude-sonnet-5")
	found.Refused = []Refused{{ID: "claude-sonnet-5", At: Timestamp(earlier)}}
	configuration := aConfiguration(map[string]config.Harness{"claude-code": {Flags: []string{}, Options: map[string]config.Option{}}})

	options := Offered(configuration, Detected{"claude-code": found}).Harnesses["claude-code"].Options

	if _, ok := options[ModelOption]; ok {
		t.Errorf("options = %v, want no model", options)
	}
}

func TestAHarnessTheConfigurationDoesNotOfferIsLeftOut(t *testing.T) {
	configuration := aConfiguration(map[string]config.Harness{"claude-code": {Flags: []string{}, Options: map[string]config.Option{}}})

	offered := Offered(configuration, Detected{"codex": aHarness("0.163.0", "gpt-5.6-terra")})

	if _, ok := offered.Harnesses["codex"]; ok {
		t.Errorf("harnesses = %v, want no codex", offered.Harnesses)
	}
	if _, ok := configuration.Harnesses["claude-code"].Options[ModelOption]; ok {
		t.Errorf("the configuration given changed: %v", configuration.Harnesses)
	}
}

func withDefault(option config.Option, value string) config.Option {
	option.Default = value
	return option
}

func TestDescribeSaysALinePerHarness(t *testing.T) {
	claudeCode := aHarness("2.1.306", "claude-sonnet-5", "claude-opus-5")
	claudeCode.Options["effort"] = OptionOf([]string{"low", "medium", "high"}, "--effort")
	confirmed := Timestamp(earlier)
	claudeCode.ConfirmedAt = &confirmed
	claudeCode.Refused = []Refused{{ID: "claude-sonnet-5", At: Timestamp(now)}}
	copilot := Harness{Version: "1.0.105", Options: map[string]config.Option{ModelOption: withDefault(OptionOf([]string{"gpt-5", "auto"}, "--model"), "auto")}}
	codex := Harness{Version: "0.163.0", Options: map[string]config.Option{}}

	got := Describe([]string{"claude-code", "copilot", "codex", "cursor"}, Detected{"claude-code": claudeCode, "copilot": copilot, "codex": codex})

	want := "claude-code 2.1.306: model claude-sonnet-5, claude-opus-5; effort low, medium, high; models confirmed 2026-11-01T09:30:00.000Z; refused claude-sonnet-5\n" +
		"copilot 1.0.105: model gpt-5, auto (default); no model confirmed\n" +
		"codex 0.163.0: no options detected; no model confirmed\n" +
		"cursor: nothing detected"
	if got != want {
		t.Errorf("Describe() =\n%s\nwant\n%s", got, want)
	}
}

func TestTheReportGivesEachHarnesssVersionConfirmationAndOptionValues(t *testing.T) {
	claudeCode := aHarness("2.1.306", "claude-sonnet-5", "claude-opus-5")
	confirmed := Timestamp(earlier)
	claudeCode.ConfirmedAt = &confirmed

	got := ReportOf(Detected{"claude-code": claudeCode})

	want := map[string]HarnessReport{"claude-code": {Version: "2.1.306", ConfirmedAt: &confirmed, Options: map[string][]string{ModelOption: {"claude-sonnet-5", "claude-opus-5"}}}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ReportOf() = %+v, want %+v", got, want)
	}
}
