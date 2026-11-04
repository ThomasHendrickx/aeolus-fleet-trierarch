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
	"strings"
	"time"
)

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
