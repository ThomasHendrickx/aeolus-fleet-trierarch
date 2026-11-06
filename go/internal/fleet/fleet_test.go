package fleet

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/activity"
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

func aSendingFleet(t *testing.T, answer func(w http.ResponseWriter)) (Client, *map[string]any) {
	t.Helper()
	var sent map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer aeolus_ct_v1_trierarch" || r.URL.Path != "/api/v1/ship/send" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&sent)
		answer(w)
	}))
	t.Cleanup(server.Close)
	return Client{URL: server.URL, CrewToken: "aeolus_ct_v1_trierarch", Model: "aeolus-trierarch@1.2.3"}, &sent
}

func TestTellsArgoByNameInMarkdownStatingItsModelWithAKeyThatMakesARetrySafe(t *testing.T) {
	client, sent := aSendingFleet(t, func(w http.ResponseWriter) { _, _ = w.Write([]byte(`{"messageId":"msg_1"}`)) })

	if err := client.ReportToArgo("headline\n\nbody", "trierarch:key:1"); err != nil {
		t.Fatal(err)
	}

	want := map[string]any{"selector": map[string]any{"kind": "ship", "name": "argo"}, "payload": "headline\n\nbody", "contentType": "text/markdown", "model": "aeolus-trierarch@1.2.3", "idempotencyKey": "trierarch:key:1"}
	if got, _ := json.Marshal(*sent); string(got) != mustJSON(want) {
		t.Errorf("sent %s, want %s", got, mustJSON(want))
	}
}

func TestTellsAnOwnerByItsShipId(t *testing.T) {
	client, sent := aSendingFleet(t, func(w http.ResponseWriter) { _, _ = w.Write([]byte(`{"messageId":"msg_1"}`)) })

	refusal, err := client.ReportToOwner("shp_owner", "text", "key")

	if err != nil || refusal != nil {
		t.Fatalf("refusal %v, err %v", refusal, err)
	}
	if got, _ := json.Marshal((*sent)["selector"]); string(got) != `{"kind":"ship","shipId":"shp_owner"}` {
		t.Errorf("selector %s", got)
	}
}

func TestAnOwnerTheFleetRefusesIsAnAnswerNotAFailure(t *testing.T) {
	client, _ := aSendingFleet(t, func(w http.ResponseWriter) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"code":"FORBIDDEN","message":"The network rules do not allow this send"}`))
	})

	refusal, err := client.ReportToOwner("shp_owner", "text", "key")

	if err != nil {
		t.Fatal(err)
	}
	if refusal == nil || refusal.Code != "FORBIDDEN" || refusal.Message != "The network rules do not allow this send" {
		t.Errorf("refusal %v", refusal)
	}
}

func TestAnOwnerTheFleetCannotBeReachedForIsAFailure(t *testing.T) {
	client := Client{URL: "http://127.0.0.1:1", CrewToken: "aeolus_ct_v1_trierarch"}

	refusal, err := client.ReportToOwner("shp_owner", "text", "key")

	if err == nil || refusal != nil {
		t.Errorf("refusal %v, err %v", refusal, err)
	}
}

func TestAsksThePluginsShipForTheTrustedRepositoriesAsItsOwnShipWithAKeyOfItsOwn(t *testing.T) {
	client, sent := aSendingFleet(t, func(w http.ResponseWriter) { _, _ = w.Write([]byte(`{"messageId":"msg_1"}`)) })

	if err := client.AskForTrustedRepositories("shp_plugin"); err != nil {
		t.Fatal(err)
	}
	first := (*sent)["idempotencyKey"]
	if err := client.AskForTrustedRepositories("shp_plugin"); err != nil {
		t.Fatal(err)
	}

	got := *sent
	if got["payload"] != "{}" || got["contentType"] != "application/vnd.aeolus.trierarch.trusted-repositories-request+json" || got["model"] != "aeolus-trierarch@1.2.3" || mustJSON(got["selector"]) != mustJSON(map[string]any{"kind": "ship", "shipId": "shp_plugin"}) {
		t.Errorf("sent %v", got)
	}
	if key, _ := got["idempotencyKey"].(string); key == "" || key == first {
		t.Errorf("idempotency keys %v then %v, want one of its own each time", first, got["idempotencyKey"])
	}
}

func TestAFleetThatRefusesTheAskIsAnError(t *testing.T) {
	client, _ := aSendingFleet(t, func(w http.ResponseWriter) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"code":"FORBIDDEN","message":"no"}`))
	})

	if err := client.AskForTrustedRepositories("shp_plugin"); err == nil {
		t.Error("AskForTrustedRepositories = nil, want the refusal")
	}
}

func TestSendsTheUsageToThePluginsShipAsItsOwnShipUnderTheKeyItIsGiven(t *testing.T) {
	client, sent := aSendingFleet(t, func(w http.ResponseWriter) { _, _ = w.Write([]byte(`{"messageId":"msg_1"}`)) })

	if err := client.SendUsage("shp_plugin", `{"hours":[]}`, "usage:shp_trierarch:2026-10-06T08:00:00.000Z"); err != nil {
		t.Fatal(err)
	}

	got := *sent
	if got["payload"] != `{"hours":[]}` || got["contentType"] != "application/vnd.aeolus.trierarch.usage+json" || got["model"] != "aeolus-trierarch@1.2.3" || got["idempotencyKey"] != "usage:shp_trierarch:2026-10-06T08:00:00.000Z" || mustJSON(got["selector"]) != mustJSON(map[string]any{"kind": "ship", "shipId": "shp_plugin"}) {
		t.Errorf("sent %v", got)
	}
}

func TestAFleetThatRefusesTheUsageIsAnError(t *testing.T) {
	client, _ := aSendingFleet(t, func(w http.ResponseWriter) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"code":"RATE_LIMITED","message":"the daily message limit"}`))
	})

	if err := client.SendUsage("shp_plugin", "{}", "usage:key"); err == nil {
		t.Error("SendUsage = nil, want the refusal")
	}
}

func TestSessionsActivitiesAreWrittenToTheFleetWithTheIntervalTheTrierarchStates(t *testing.T) {
	var asked map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/fleet/reportActivity" || r.Header.Get("Authorization") != "Bearer aeolus_ct_v1_trierarch" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&asked)
		_, _ = w.Write([]byte(`{"refused":[]}`))
	}))
	defer server.Close()
	at := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)

	err := Client{URL: server.URL, CrewToken: "aeolus_ct_v1_trierarch"}.ReportActivity(30, []ShipActivity{
		{ShipID: shipID, Activity: activity.Activity{At: at, Kind: "tool", Tool: "Bash"}},
		{ShipID: "shp_other", Activity: activity.Activity{At: at, Kind: "result"}},
	})

	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"intervalSeconds": 30, "activities": []any{
		map[string]any{"shipId": shipID, "at": "2026-11-05T12:00:00.000Z", "kind": "tool", "tool": "Bash"},
		map[string]any{"shipId": "shp_other", "at": "2026-11-05T12:00:00.000Z", "kind": "result"},
	}}
	if got, _ := json.Marshal(asked); string(got) != mustJSON(want) {
		t.Errorf("asked %s, want %s", got, mustJSON(want))
	}
}

func TestMoreThan100ActivitiesAreWrittenInCallsOfAtMost100(t *testing.T) {
	var sizes []int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var asked struct {
			Activities []any `json:"activities"`
		}
		_ = json.NewDecoder(r.Body).Decode(&asked)
		sizes = append(sizes, len(asked.Activities))
		_, _ = w.Write([]byte(`{"refused":[]}`))
	}))
	defer server.Close()
	activities := make([]ShipActivity, 101)
	for i := range activities {
		activities[i] = ShipActivity{ShipID: shipID, Activity: activity.Activity{At: time.Now(), Kind: "text"}}
	}

	err := Client{URL: server.URL, CrewToken: "aeolus_ct_v1_trierarch"}.ReportActivity(30, activities)

	if err != nil {
		t.Fatal(err)
	}
	if len(sizes) != 2 || sizes[0] != 100 || sizes[1] != 1 {
		t.Errorf("calls of %v activities, want [100 1]", sizes)
	}
}

func TestAsksThePluginsShipForTheMcpServersAsItsOwnShipWithAKeyOfItsOwn(t *testing.T) {
	client, sent := aSendingFleet(t, func(w http.ResponseWriter) { _, _ = w.Write([]byte(`{"messageId":"msg_1"}`)) })

	if err := client.AskForMcpServers("shp_plugin"); err != nil {
		t.Fatal(err)
	}
	first := (*sent)["idempotencyKey"]
	if err := client.AskForMcpServers("shp_plugin"); err != nil {
		t.Fatal(err)
	}

	got := *sent
	if got["payload"] != "{}" || got["contentType"] != "application/vnd.aeolus.trierarch.mcp-servers-request+json" || mustJSON(got["selector"]) != mustJSON(map[string]any{"kind": "ship", "shipId": "shp_plugin"}) {
		t.Errorf("sent %v", got)
	}
	if key, _ := got["idempotencyKey"].(string); key == "" || key == first {
		t.Errorf("idempotency keys %v then %v, want one of its own each time", first, got["idempotencyKey"])
	}
}

func TestAsksThePluginsShipForTheSecretsAsItsOwnShipWithAKeyOfItsOwn(t *testing.T) {
	client, sent := aSendingFleet(t, func(w http.ResponseWriter) { _, _ = w.Write([]byte(`{"messageId":"msg_1"}`)) })

	if err := client.AskForSecrets("shp_plugin"); err != nil {
		t.Fatal(err)
	}
	first := (*sent)["idempotencyKey"]
	if err := client.AskForSecrets("shp_plugin"); err != nil {
		t.Fatal(err)
	}

	got := *sent
	if got["payload"] != "{}" || got["contentType"] != "application/vnd.aeolus.trierarch.secrets-request+json" || mustJSON(got["selector"]) != mustJSON(map[string]any{"kind": "ship", "shipId": "shp_plugin"}) {
		t.Errorf("sent %v", got)
	}
	if key, _ := got["idempotencyKey"].(string); key == "" || key == first {
		t.Errorf("idempotency keys %v then %v, want one of its own each time", first, got["idempotencyKey"])
	}
}
