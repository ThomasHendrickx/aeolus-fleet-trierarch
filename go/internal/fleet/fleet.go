// Package fleet is the fleet over its REST API (`/api/v1`), with the calls
// init makes: register the trierarch's own ship, and whoami to tell whether
// the kept crew token still holds its lease.
package fleet

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// MinimumCoreVersion is the oldest core the trierarch runs against (decision 0049, docs/compatibility.md), today's trierarch's MINIMUM_CORE_VERSION.
const MinimumCoreVersion = "0.35.0"

// Harness is what the trierarch registers its own ship with.
const Harness = "aeolus-trierarch"

const callTimeout = 30 * time.Second

// Refusal is the fleet's own refusal: its code and its message.
type Refusal struct {
	Code    string
	Message string
}

func (r *Refusal) Error() string {
	return r.Code + ": " + r.Message
}

// request is one call to the fleet.
type request struct {
	path      string
	crewToken string
	body      any
}

// call makes one call: a GET without a body, a POST with one. A crew token that is empty is not sent.
func call(fleetURL string, at request, answer any) error {
	url := strings.TrimSuffix(fleetURL, "/") + "/api/v1" + at.path
	method := http.MethodGet
	var body io.Reader
	if at.body != nil {
		text, err := json.Marshal(at.body)
		if err != nil {
			return err
		}
		method = http.MethodPost
		body = bytes.NewReader(text)
	}
	request, err := http.NewRequest(method, url, body)
	if err != nil {
		return err
	}
	if at.body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if at.crewToken != "" {
		request.Header.Set("Authorization", "Bearer "+at.crewToken)
	}
	client := http.Client{Timeout: callTimeout}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("the fleet at %s cannot be reached: %w", fleetURL, err)
	}
	defer response.Body.Close()
	text, err := io.ReadAll(response.Body)
	if err != nil {
		return fmt.Errorf("the fleet at %s cannot be reached: %w", fleetURL, err)
	}
	if !json.Valid(text) {
		return fmt.Errorf("the fleet at %s cannot be reached: it answered %d without JSON, as while it restarts", fleetURL, response.StatusCode)
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		var refusal Refusal
		var said struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if json.Unmarshal(text, &said) == nil && said.Code != "" {
			refusal = Refusal{Code: said.Code, Message: said.Message}
		} else {
			refusal = Refusal{Code: fmt.Sprint(response.StatusCode), Message: "The fleet refused"}
		}
		return &refusal
	}
	return json.Unmarshal(text, answer)
}

// Register registers the trierarch's own ship with its secret and answers its crew token.
func Register(fleetURL string, shipID string, secret string) (string, error) {
	var answer struct {
		CrewToken string `json:"crewToken"`
	}
	body := map[string]any{"shipId": shipID, "secret": secret, "harness": Harness, "location": map[string]string{"kind": "DEVICE"}}
	if err := call(fleetURL, request{path: "/ship/register", body: body}, &answer); err != nil {
		return "", err
	}
	if answer.CrewToken == "" {
		return "", fmt.Errorf("the fleet at %s answered no crew token", fleetURL)
	}
	return answer.CrewToken, nil
}

// IsLeaseHeld says whether the crew token still holds its lease: it no longer does once the ship was released.
func IsLeaseHeld(fleetURL string, crewToken string) (bool, error) {
	var answer struct {
		ShipID string `json:"shipId"`
	}
	err := call(fleetURL, request{path: "/ship/whoami", crewToken: crewToken}, &answer)
	var refusal *Refusal
	if errors.As(err, &refusal) && (refusal.Code == "LEASE_ENDED" || refusal.Code == "UNAUTHORIZED") {
		return false, nil
	}
	return err == nil, err
}

// Client is the fleet as the running trierarch calls it: with its own crew token, its crew:run calls for the ships assigned to it, and a session's report with that session's crew token.
type Client struct {
	URL       string
	CrewToken string
	// Model is what every message the trierarch sends states as the model it runs, as today's trierarch states its package and version.
	Model string
}

// AssignedRequests are the crew requests assigned to the trierarch.
func (c Client) AssignedRequests() ([]reconciler.Request, error) {
	requests := []reconciler.Request{}
	err := call(c.URL, request{path: "/fleet/assignedCrewRequests", crewToken: c.CrewToken}, &requests)
	return requests, err
}

// Ship is a ship as the fleet holds it: its name and its status, awaitingCrew, crewed or retired, or notFound.
type Ship struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

func (c Client) Ship(shipID string) (Ship, error) {
	var ship Ship
	err := call(c.URL, request{path: "/fleet/ship", crewToken: c.CrewToken, body: map[string]string{"shipId": shipID}}, &ship)
	var refusal *Refusal
	if errors.As(err, &refusal) && refusal.Code == "NOT_FOUND" {
		return Ship{Status: "notFound"}, nil
	}
	return ship, err
}

// StartingSecret is the secret a ship's starting prompt gives, which registers its crew.
func (c Client) StartingSecret(shipID string) (string, error) {
	var answer struct {
		Secret string `json:"secret"`
	}
	err := call(c.URL, request{path: "/fleet/getStartingPrompt", crewToken: c.CrewToken, body: map[string]string{"shipId": shipID}}, &answer)
	return answer.Secret, err
}

// RegisterShip registers a ship's crew with its secret, as its session's harness, and answers its crew token.
func (c Client) RegisterShip(shipID string, secret string, harness string) (string, error) {
	var answer struct {
		CrewToken string `json:"crewToken"`
	}
	body := map[string]any{"shipId": shipID, "secret": secret, "harness": harness, "location": map[string]string{"kind": "DEVICE"}}
	if err := call(c.URL, request{path: "/ship/register", body: body}, &answer); err != nil {
		return "", err
	}
	if answer.CrewToken == "" {
		return "", fmt.Errorf("the fleet at %s answered no crew token", c.URL)
	}
	return answer.CrewToken, nil
}

// Release ends the lease of a ship the trierarch crews.
func (c Client) Release(shipID string) error {
	return call(c.URL, request{path: "/fleet/release", crewToken: c.CrewToken, body: map[string]string{"shipId": shipID}}, &map[string]any{})
}

// ConfirmRelease confirms a removed request is ended here: the request goes.
func (c Client) ConfirmRelease(shipID string) error {
	return call(c.URL, request{path: "/fleet/confirmCrewRelease", crewToken: c.CrewToken, body: map[string]string{"shipId": shipID}}, &map[string]any{})
}

// WriteStatus writes a crew status with its restart attempt and when the session running now started, empty while none runs.
func (c Client) WriteStatus(shipID string, status string, attempt int, startedAt string) error {
	var started any
	if startedAt != "" {
		started = startedAt
	}
	body := map[string]any{"shipId": shipID, "status": status, "attempt": attempt, "startedAt": started}
	return call(c.URL, request{path: "/fleet/reportCrewStatus", crewToken: c.CrewToken, body: body}, &map[string]any{})
}

// GiveBack gives back a request the trierarch cannot crew, with why.
func (c Client) GiveBack(shipID string, settingsVersion int, reason string) error {
	body := map[string]any{"shipId": shipID, "settingsVersion": settingsVersion, "reason": reason}
	return call(c.URL, request{path: "/fleet/giveBackCrewRequest", crewToken: c.CrewToken, body: body}, &map[string]any{})
}

// Inbox is a session's inbox, asked with its crew token: what waits, of it what is forced, or its lease ended (released or retired elsewhere).
func (c Client) Inbox(crewToken string) (reconciler.Inbox, error) {
	var answer struct {
		Waiting int `json:"waiting"`
		Forced  int `json:"forced"`
	}
	err := call(c.URL, request{path: "/ship/inbox", crewToken: crewToken, body: map[string]any{}}, &answer)
	var refusal *Refusal
	if errors.As(err, &refusal) && (refusal.Code == "LEASE_ENDED" || refusal.Code == "UNAUTHORIZED") {
		return reconciler.Inbox{IsLeaseEnded: true}, nil
	}
	if err != nil {
		return reconciler.Inbox{}, err
	}
	return reconciler.Inbox{Waiting: answer.Waiting, Forced: answer.Forced}, nil
}

// ReportFor reports on a ship's behalf, with its session's crew token.
func (c Client) ReportFor(crewToken string, state string, note string) error {
	return call(c.URL, request{path: "/ship/report", crewToken: crewToken, body: map[string]string{"state": state, "note": note}}, &map[string]any{})
}

// send sends a message from the trierarch's own ship to the ship named or identified by the selector, as markdown.
func (c Client) send(selector map[string]string, text string, idempotencyKey string) error {
	body := map[string]any{"selector": selector, "payload": text, "contentType": "text/markdown", "model": c.Model, "idempotencyKey": idempotencyKey}
	return call(c.URL, request{path: "/ship/send", crewToken: c.CrewToken, body: body}, &map[string]any{})
}

// ReportToArgo tells argo; the idempotency key makes a retry safe, so a notice told twice reaches argo once.
func (c Client) ReportToArgo(text string, idempotencyKey string) error {
	return c.send(map[string]string{"kind": "ship", "name": "argo"}, text, idempotencyKey)
}

// ReportToOwner tells a ship's owner. A refusal of the fleet, as when no rule lets the trierarch reach the owner, is answered as the refusal, not as a failure.
func (c Client) ReportToOwner(ownerShipID string, text string, idempotencyKey string) (*Refusal, error) {
	err := c.send(map[string]string{"kind": "ship", "shipId": ownerShipID}, text, idempotencyKey)
	var refusal *Refusal
	if errors.As(err, &refusal) {
		return refusal, nil
	}
	return nil, err
}

var versionPattern = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`)

func versionOf(text string) []int {
	match := versionPattern.FindStringSubmatch(text)
	if match == nil {
		return nil
	}
	parts := []int{}
	for _, part := range match[1:] {
		number, _ := strconv.Atoi(part)
		parts = append(parts, number)
	}
	return parts
}

// CoreVersionRefusal is why the trierarch may not start against the fleet's core (decision 0049), as common's coreVersionRefusal says it, or empty when it may: core is at least the minimum, or 0.0.0, a build from main.
func CoreVersionRefusal(fleetURL string, version string, minimum string) string {
	needs := fmt.Sprintf("trierarch %s needs core %s or later", version, minimum)
	unread := func(why string) string {
		return fmt.Sprintf("%s, and could not read the version of the fleet at %s: %s", needs, fleetURL, why)
	}
	client := http.Client{Timeout: 10 * time.Second}
	response, err := client.Get(strings.TrimRight(fleetURL, "/") + "/api/version")
	if err != nil {
		return unread(err.Error())
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return unread(fmt.Sprintf("HTTP %d", response.StatusCode))
	}
	var answer struct {
		Server string `json:"server"`
	}
	core := []int(nil)
	if json.NewDecoder(response.Body).Decode(&answer) == nil {
		core = versionOf(answer.Server)
	}
	if core == nil {
		return unread("its /api/version answered no core version")
	}
	if slices.Equal(core, []int{0, 0, 0}) || slices.Compare(core, versionOf(minimum)) >= 0 {
		return ""
	}
	return fmt.Sprintf("%s; the fleet at %s runs core %s: upgrade core first", needs, fleetURL, answer.Server)
}
