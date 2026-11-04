package fleet

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

const shipID = "shp_01m6jwb5xwnnezed207ddz58ep"

func TestRegistersTheTrierarchsShipWithItsSecretAndKeepsNoSecret(t *testing.T) {
	var asked map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/ship/register" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&asked)
		_, _ = w.Write([]byte(`{"crewToken":"aeolus_ct_v1_trierarch"}`))
	}))
	defer server.Close()

	crewToken, err := Register(server.URL, shipID, "aeolus_sk_v1_secret")

	if err != nil {
		t.Fatal(err)
	}
	if crewToken != "aeolus_ct_v1_trierarch" {
		t.Errorf("crew token %q", crewToken)
	}
	want := map[string]any{"shipId": shipID, "secret": "aeolus_sk_v1_secret", "harness": "aeolus-trierarch", "location": map[string]any{"kind": "DEVICE"}}
	if got, _ := json.Marshal(asked); string(got) != mustJSON(want) {
		t.Errorf("asked %s, want %s", got, mustJSON(want))
	}
}

func TestARefusalCarriesTheFleetsCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"CONFLICT","message":"crewed already"}`))
	}))
	defer server.Close()

	_, err := Register(server.URL, shipID, "aeolus_sk_v1_secret")

	var refusal *Refusal
	if !errors.As(err, &refusal) || refusal.Code != "CONFLICT" {
		t.Errorf("err %v, want a CONFLICT refusal", err)
	}
}

func TestWhoamiPassesTheCrewTokenAndSaysAnEndedLease(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/ship/whoami" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") == "Bearer aeolus_ct_v1_held" {
			_, _ = w.Write([]byte(`{"shipId":"` + shipID + `","name":"mac-mini"}`))
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"code":"LEASE_ENDED","message":"released"}`))
	}))
	defer server.Close()

	if held, err := IsLeaseHeld(server.URL, "aeolus_ct_v1_held"); err != nil || !held {
		t.Errorf("held %v, err %v, want held", held, err)
	}
	if held, err := IsLeaseHeld(server.URL, "aeolus_ct_v1_ended"); err != nil || held {
		t.Errorf("held %v, err %v, want ended", held, err)
	}
}

func TestAFleetThatAnswersNoJSONCannotBeReached(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`<html>restarting</html>`))
	}))
	defer server.Close()

	_, err := IsLeaseHeld(server.URL, "aeolus_ct_v1_held")

	var refusal *Refusal
	if err == nil || errors.As(err, &refusal) {
		t.Errorf("err %v, want an unreachable fleet", err)
	}
}

func mustJSON(value any) string {
	text, _ := json.Marshal(value)
	return string(text)
}
