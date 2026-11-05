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

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/detection"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/machineload"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/trust"
)

// keyCutOffNote is what the report says while the fleet refuses to receive for lack of its key (decision 0068).
const keyCutOffNote = "waiting for the fleet's key (KEY_UNAVAILABLE)"

// riskyFlags are, by harness, the flags its adapter calls risky, so a reader needs no harness knowledge (#326).
var riskyFlags = map[string][]string{
	"claude-code": {"--dangerously-skip-permissions"},
	"codex":       {"--dangerously-bypass-approvals-and-sandbox"},
	"copilot":     {"--allow-all", "--yolo", "--allow-all-paths", "--allow-all-urls"},
}

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
	State   reconciler.State
	// Running is how many sessions run.
	Running int
	Logins  Logins
	Version string
	// OS and Arch are Go's names of the platform and chip.
	OS, Arch    string
	IsKeyCutOff bool
	// Load is the machine's load as last read; none before one could be (#400).
	Load *machineload.Load
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
	state := "idle"
	if in.Running > 0 {
		state = "working"
	}
	if in.IsKeyCutOff {
		state, note = "blocked", note+", "+keyCutOffNote
	}
	return Report{State: state, Note: note, Details: detailsOf(in)}
}

func detailsOf(in Input) map[string]any {
	details := map[string]any{
		"harnesses": harnessesOf(in),
		"workspaces": map[string]any{
			"repositories": offeredPlaces(in, slices.Sorted(maps.Keys(in.Configuration.Repositories)), func(places trust.Places) []string { return places.Repositories }),
			"folders":      offeredPlaces(in, slices.Sorted(maps.Keys(in.Configuration.Folders)), func(places trust.Places) []string { return places.Folders }),
		},
		"caps": in.Configuration.Caps,
		// Paths stay on the machine: names only (decision 0032).
		"kept":    pickedFrom(in.State.Kept, "shipId", "repository"),
		"orphans": pickedFrom(in.State.Orphans, "repository", "name"),
		"logins":  shipLoginsOf(in),
		// A fact for the console, never a label: placement does not read it (decision 0039).
		"runtime": runtimeOf(in.Configuration),
		"version": in.Version,
	}
	if in.Load != nil {
		details["load"] = in.Load
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

// Reporter reports on start and then only when the report would differ from the last one sent.
type Reporter struct {
	Fleet    Fleet
	Store    Store
	Sessions Sessions
	// Load reads the machine's load, at most once a minute (#400); none reports none.
	Load LoadReader
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
