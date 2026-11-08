// Package selfreport is the trierarch's report as its own ship
// (docs/trierarch.md, "What a trierarch reports"): working while a session
// runs, idle with none, a note saying how many run of its cap and how many
// crashed, and its details from its configuration and saved state. It reports
// at start, then only when the report would differ from the last one sent.
package selfreport

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/failedstarts"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/machineload"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/secrets"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/trust"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/usage"
)

// keyCutOffNote is what the report says while the fleet refuses to receive for lack of its key (decision 0068).
const keyCutOffNote = "waiting for the fleet's key (KEY_UNAVAILABLE)"

// aipMissingNote is what the report says while host sessions get no aip (#314).
const aipMissingNote = ", no aip on the host"

// noteMost is the longest note core takes (common's REPORT_NOTE_MAX_LENGTH).
const noteMost = 200

// riskyFlags are, by harness, the flags its adapter calls risky, so a reader needs no harness knowledge (#326).
var riskyFlags = map[string][]string{
	"claude-code": {"--dangerously-skip-permissions"},
	"codex":       {"--dangerously-bypass-approvals-and-sandbox"},
	"copilot":     {"--allow-all", "--yolo", "--allow-all-paths", "--allow-all-urls"},
}

// pluginMissingReason is why a harness whose aeolus-fleet plugin could not be found is not offered (#1212).
const pluginMissingReason = "its aeolus-fleet plugin is not installed (run aeolus-trierarch upgrade)"

// osOf and archOf name the platforms the trierarch plugin labels by; any other is left out.
var (
	osOf   = map[string]string{"darwin": "macos", "linux": "linux", "windows": "windows"}
	archOf = map[string]string{"arm64": "arm64", "amd64": "amd64"}
)

// Report is what the trierarch's own ship reports.
type Report struct {
	State   string         `json:"state"`
	Note    string         `json:"note"`
	Details map[string]any `json:"details"`
}

// Input is what a report is made of.
type Input struct {
	// Configuration is the configuration as offered: with the options detection found.
	Configuration config.Configuration
	Detected      detection.Detected
	// Harnesses are the harnesses this trierarch offers, in order.
	Harnesses []string
	// Trusted is what each harness trusts, read afresh for this report (#381).
	Trusted map[string]trust.Places
	// McpServers are, by harness, the names of the MCP servers it offers; a harness missing offers none.
	McpServers map[string][]string
	// SealingKey is the trierarch's public key, base64, the trierarch plugin seals each secret to; empty without one.
	SealingKey string
	State      reconciler.State
	// Running is how many sessions run.
	Running int
	Logins  Logins
	Version string
	// OS and Arch are Go's names of the platform and chip.
	OS, Arch    string
	IsKeyCutOff bool
	// Now is the time of the report: when the machine that stopped offering itself offers itself again for a probe (#853).
	Now time.Time
	// Load is the machine's load as last read; none before one could be (#400).
	Load *machineload.Load
	// Usage is the harnesses' usage as last read (#353); none reports none.
	Usage *usage.Usage
	// AipMissing is why host sessions get no aip (#314), briefly; empty while they get it or the machine runs none.
	AipMissing string
}

// Logins are which login each ship's next session starts on, and where each harness's API key stands.
type Logins interface {
	LoginOf(harness string, shipName string) string
	KeyState(harness string) (state string, at string)
}

// Of is the report for the input.
func Of(in Input) Report {
	crashed := 0
	for _, entry := range in.State.Entries {
		if entry.State == "crashed" {
			crashed++
		}
	}
	note := fmt.Sprintf("%d of %d running", in.Running, in.Configuration.Caps.Ships)
	if crashed > 0 {
		note += fmt.Sprintf(", %d crashed", crashed)
	}
	// A harness without its aeolus-fleet plugin cannot crew a ship (#1212), nor one its adapter does not offer (CC3): the note says why. An adapter's own reason says more than the plugin missing.
	for _, each := range notOfferedOf(in) {
		note += fmt.Sprintf(", %s not offered: %s", each.Harness, each.Reason)
	}
	// A machine whose session starts keep failing offers nothing (#853) until its probe is due.
	stopped := whyNotOffered(in)
	if stopped != "" {
		note += ", not offered: " + stopped
	}
	state := "idle"
	if in.Running > 0 {
		state = "working"
	}
	if in.IsKeyCutOff {
		state, note = "blocked", note+", "+keyCutOffNote
	}
	// Core refuses a longer note, and with it the whole report: the aip is the one part shortened, then left out, for it.
	if in.AipMissing != "" {
		for _, aip := range []string{aipMissingNote + ": " + in.AipMissing, aipMissingNote} {
			if len(note)+len(aip) <= noteMost {
				note += aip
				break
			}
		}
	}
	return Report{State: state, Note: note, Details: detailsOf(in)}
}

// notOfferedOf are the harnesses the last pass found not offered, with why: those whose plugin is missing first, then those their adapters do not offer.
func notOfferedOf(in Input) []reconciler.NotOfferedHarness {
	notOffered := []reconciler.NotOfferedHarness{}
	for _, harness := range in.State.MissingPlugins {
		if !slices.ContainsFunc(in.State.NotOffered, func(each reconciler.NotOfferedHarness) bool { return each.Harness == harness }) {
			notOffered = append(notOffered, reconciler.NotOfferedHarness{Harness: harness, Reason: pluginMissingReason})
		}
	}
	return append(notOffered, in.State.NotOffered...)
}

// notOfferedDetailsOf are the harnesses the report names as not offered, each with why: its own reason when the last pass found one, else why the machine offers itself for no placement now (#853).
func notOfferedDetailsOf(in Input, stopped string) []reconciler.NotOfferedHarness {
	notOffered := notOfferedOf(in)
	if stopped == "" {
		return notOffered
	}
	for _, name := range in.Harnesses {
		if !slices.ContainsFunc(notOffered, func(each reconciler.NotOfferedHarness) bool { return each.Harness == name }) {
			notOffered = append(notOffered, reconciler.NotOfferedHarness{Harness: name, Reason: stopped})
		}
	}
	return notOffered
}

// offeredHarnessesOf are the harnesses this trierarch offers that the machine can crew now: those not left out of the report as not offered.
func offeredHarnessesOf(in Input) []string {
	notOffered := notOfferedOf(in)
	return slices.DeleteFunc(slices.Clone(in.Harnesses), func(name string) bool {
		return slices.ContainsFunc(notOffered, func(each reconciler.NotOfferedHarness) bool { return each.Harness == name })
	})
}

// whyNotOffered is why the machine offers itself for no placement now (#853), or none while it offers itself.
func whyNotOffered(in Input) string {
	starts := in.State.FailedStarts
	if starts == nil || failedstarts.IsOffering(starts, in.Now) {
		return ""
	}
	return failedstarts.NotOfferedReason(*starts)
}

// capsOf are the caps as reported: in its probe the machine has room for one start only, above the ships it holds, until a start decides (#853).
func capsOf(in Input) config.Caps {
	caps := in.Configuration.Caps
	if !failedstarts.IsProbing(in.State.FailedStarts, in.Now) {
		return caps
	}
	isStartUndecided := false
	for _, entry := range in.State.Entries {
		isStartUndecided = isStartUndecided || entry.State == "crewing" || entry.State == "restarting" || entry.LaunchedAt != ""
	}
	caps.Ships = failedstarts.ProbeShipsCap(len(in.State.Entries), caps.Ships, isStartUndecided)
	return caps
}

func detailsOf(in Input) map[string]any {
	stopped := whyNotOffered(in)
	named := in
	named.Harnesses = offeredHarnessesOf(in)
	if stopped != "" {
		// It offers no harness, and so no place, naming each harness with why.
		named.Harnesses = nil
	}
	details := map[string]any{
		"harnesses": harnessesOf(named),
		"workspaces": map[string]any{
			"repositories": offeredPlaces(named, slices.Sorted(maps.Keys(in.Configuration.Repositories)), func(places trust.Places) []string { return places.Repositories }),
			"folders":      offeredPlaces(named, slices.Sorted(maps.Keys(in.Configuration.Folders)), func(places trust.Places) []string { return places.Folders }),
		},
		"caps": capsOf(in),
		// Paths stay on the machine: names only (decision 0032).
		"kept":    pickedFrom(in.State.Kept, "shipId", "repository"),
		"orphans": pickedFrom(in.State.Orphans, "repository", "name"),
		"logins":  shipLoginsOf(in),
		// A fact for the console, never a label: placement does not read it (decision 0039).
		"runtime": runtimeOf(in.Configuration),
		"version": in.Version,
	}
	if notOffered := notOfferedDetailsOf(in, stopped); len(notOffered) > 0 {
		details["notOffered"] = notOffered
	}
	if in.SealingKey != "" {
		details["sealingKey"] = map[string]string{"scheme": secrets.Scheme, "publicKey": in.SealingKey}
	}
	if in.Load != nil {
		details["load"] = in.Load
	}
	if in.Usage != nil {
		details["usage"] = in.Usage
	}
	machine := map[string]string{}
	if name, ok := osOf[in.OS]; ok {
		machine["os"] = name
	}
	if name, ok := archOf[in.Arch]; ok {
		machine["arch"] = name
	}
	if len(machine) > 0 {
		details["machine"] = machine
	}
	return details
}

func runtimeOf(configuration config.Configuration) string {
	if configuration.Runtime == nil || configuration.Runtime.Kind == "" {
		return "host"
	}
	return configuration.Runtime.Kind
}

// offeredPlaces are the places every offered harness trusts, and none without a harness to crew them (#381).
func offeredPlaces(in Input, names []string, trustedOf func(trust.Places) []string) []string {
	offered := []string{}
	if len(in.Harnesses) == 0 {
		return offered
	}
	for _, name := range names {
		if slices.ContainsFunc(in.Harnesses, func(harness string) bool { return !slices.Contains(trustedOf(in.Trusted[harness]), name) }) {
			continue
		}
		offered = append(offered, name)
	}
	return offered
}

func harnessesOf(in Input) []map[string]any {
	harnesses := []map[string]any{}
	for _, name := range in.Harnesses {
		settings := in.Configuration.Harnesses[name]
		flags := append([]string{}, settings.Flags...)
		risky := []string{}
		for _, flag := range flags {
			base, _, _ := strings.Cut(flag, "=")
			if slices.Contains(riskyFlags[name], base) {
				risky = append(risky, flag)
			}
		}
		harness := map[string]any{"harness": name, "options": optionsSchemaOf(settings), "flags": flags, "riskyFlags": risky, "login": loginOf(in, name)}
		if servers := in.McpServers[name]; len(servers) > 0 {
			harness["mcpServers"] = servers
		}
		if found, ok := in.Detected[name]; ok && found.Version != "" {
			harness["version"] = found.Version
			harness["modelsConfirmedAt"] = found.ConfirmedAt
		}
		harnesses = append(harnesses, harness)
	}
	return harnesses
}

// optionsSchemaOf is a harness's options as a JSON Schema: each option one of its value names, with its default when it has one.
func optionsSchemaOf(settings config.Harness) map[string]any {
	properties := map[string]any{}
	for name, option := range settings.Options {
		property := map[string]any{"enum": option.Names()}
		if option.Default != "" {
			property["default"] = option.Default
		}
		properties[name] = property
	}
	return map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
}

// loginOf is a harness's login as reported (K8): its default and its key's state, never the key (K7).
func loginOf(in Input, harness string) map[string]any {
	login := map[string]any{"default": defaultLogin(in.Configuration, harness), "key": "none"}
	if in.Logins != nil {
		key, at := in.Logins.KeyState(harness)
		login["key"] = key
		if at != "" {
			login["keyStateAt"] = at
		}
	}
	return login
}

func defaultLogin(configuration config.Configuration, harness string) string {
	if configuration.Logins != nil && configuration.Logins.Default != nil {
		defaults := configuration.Logins.Default
		if login := map[string]string{"claude-code": defaults.ClaudeCode, "codex": defaults.Codex}[harness]; login != "" {
			return login
		}
	}
	return "subscription"
}

// shipLoginsOf is the login of each ship whose session started (K8), with the other one its next start would use (K3).
func shipLoginsOf(in Input) []map[string]string {
	logins := []map[string]string{}
	for _, id := range slices.Sorted(maps.Keys(in.State.Entries)) {
		entry := in.State.Entries[id]
		if entry.Login == "" {
			continue
		}
		login := map[string]string{"shipId": entry.ShipID, "login": entry.Login}
		name := entry.ShipName
		if name == "" {
			name = entry.ShipID
		}
		if in.Logins != nil {
			if next := in.Logins.LoginOf(entry.Harness, name); next != entry.Login {
				login["next"] = next
			}
		}
		logins = append(logins, login)
	}
	return logins
}

// pickedFrom keeps only the named fields of each saved item, so nothing else of the state is carried.
func pickedFrom(items []any, fields ...string) []map[string]any {
	picked := []map[string]any{}
	for _, item := range items {
		fromItem, ok := item.(map[string]any)
		if !ok {
			continue
		}
		one := map[string]any{}
		for _, field := range fields {
			one[field] = fromItem[field]
		}
		picked = append(picked, one)
	}
	return picked
}

// Fleet takes the report of the trierarch's own ship.
type Fleet interface {
	ReportSelf(state string, note string, details any) error
}

// Store is the saved state.
type Store interface {
	Load() (reconciler.State, error)
}

// Sessions are the sessions that run.
type Sessions interface {
	List() ([]sessions.Observed, error)
}

// LoadReader is the machine's load, as last read.
type LoadReader interface {
	Read() (load *machineload.Load, isFresh bool)
}

// UsageReader is the harnesses' usage, each part read on its own interval.
type UsageReader interface {
	Read() (usage.Usage, error)
}

// Reporter reports on start and then only when the report would differ from the last one sent.
type Reporter struct {
	Fleet    Fleet
	Store    Store
	Sessions Sessions
	// Load reads the machine's load, at most once a minute (#400); none reports none.
	Load LoadReader
	// Usage reads the harnesses' usage (#353); none reports none.
	Usage UsageReader
	// Input is the input as this machine has it now, without what a pass reads: the state and the sessions that run.
	Input func() Input
	last  string
}

// Report reports when the report differs from the last one sent; isKeyCutOff is whether the fleet's key is cut off now.
func (r *Reporter) Report(isKeyCutOff bool) error {
	in := r.Input()
	state, err := r.Store.Load()
	if err != nil {
		return err
	}
	running, err := r.Sessions.List()
	if err != nil {
		return err
	}
	in.State = state
	in.Running = len(slices.DeleteFunc(running, func(each sessions.Observed) bool { return each.Status != "running" }))
	in.IsKeyCutOff = isKeyCutOff
	if r.Load != nil {
		in.Load, _ = r.Load.Read()
	}
	if r.Usage != nil {
		read, err := r.Usage.Read()
		if err != nil {
			return err
		}
		in.Usage = &read
	}
	report := Of(in)
	text, err := changeOf(report, in.Load)
	if err != nil {
		return err
	}
	if text == r.last {
		return nil
	}
	if err := r.Fleet.ReportSelf(report.State, report.Note, report.Details); err != nil {
		return err
	}
	r.last = text
	return nil
}

// changeOf is what makes a report another one: the report with its load by steps only, as a load always moves (#400).
func changeOf(report Report, load *machineload.Load) (string, error) {
	details := maps.Clone(report.Details)
	if load != nil {
		details["load"] = load.Steps()
	}
	report.Details = details
	text, err := json.Marshal(report)
	return string(text), err
}
