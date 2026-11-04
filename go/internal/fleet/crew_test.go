package fleet

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const scout = "shp_01m6jyczpnpp5c0vxh54c966cy"

// aRecordingFleet answers each path with its text, and keeps what each call asked: its method, its bearer and its body.
type aRecordingFleet struct {
	answers map[string]string
	asked   map[string]string
	bearers map[string]string
}

func aFleetAnswering(t *testing.T, answers map[string]string) (*aRecordingFleet, Client) {
	t.Helper()
	recorded := &aRecordingFleet{answers: answers, asked: map[string]string{}, bearers: map[string]string{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		answer, ok := recorded.answers[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"code":"NOT_FOUND","message":"no such ship"}`))
			return
		}
		var body strings.Builder
		_, _ = body.ReadFrom(r.Body)
		recorded.asked[r.URL.Path] = r.Method + " " + body.String()
		recorded.bearers[r.URL.Path] = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(answer))
	}))
	t.Cleanup(server.Close)
	return recorded, Client{URL: server.URL, CrewToken: "aeolus_ct_v1_trierarch"}
}

func sameJSON(t *testing.T, got string, want string) {
	t.Helper()
	var gotValue, wantValue any
	_ = json.Unmarshal([]byte(strings.TrimPrefix(strings.TrimPrefix(got, "POST "), "GET ")), &gotValue)
	_ = json.Unmarshal([]byte(want), &wantValue)
	gotText, _ := json.Marshal(gotValue)
	wantText, _ := json.Marshal(wantValue)
	if string(gotText) != string(wantText) {
		t.Fatalf("asked %s, want %s", gotText, wantText)
	}
}

func TestTheAssignedRequestsAreReadWithTheTrierarchsCrewToken(t *testing.T) {
	recorded, client := aFleetAnswering(t, map[string]string{"/api/v1/fleet/assignedCrewRequests": `[{"shipId":"` + scout + `","settings":{"harness":"claude-code","workspace":{"kind":"worktree","repository":"aeolus-fleet"},"options":{}},"settingsVersion":2,"requestedAt":"2026-11-04T10:00:00.000Z","status":"running","isFinal":true,"ownerShipId":null,"ownerName":null}]`})

	requests, err := client.AssignedRequests()

	if err != nil {
		t.Fatal(err)
	}
	if len(requests) != 1 || requests[0].ShipID != scout || requests[0].SettingsVersion != 2 || requests[0].Status == nil || *requests[0].Status != "running" || !requests[0].IsFinal || requests[0].Settings.Workspace.Repository != "aeolus-fleet" {
		t.Fatalf("requests: %+v", requests)
	}
	if recorded.asked["/api/v1/fleet/assignedCrewRequests"] != "GET " || recorded.bearers["/api/v1/fleet/assignedCrewRequests"] != "Bearer aeolus_ct_v1_trierarch" {
		t.Fatalf("asked %q with %q", recorded.asked["/api/v1/fleet/assignedCrewRequests"], recorded.bearers["/api/v1/fleet/assignedCrewRequests"])
	}
}

func TestAShipIsSaidByItsStatusAndName(t *testing.T) {
	_, client := aFleetAnswering(t, map[string]string{"/api/v1/fleet/ship": `{"shipId":"` + scout + `","name":"scout","status":"awaitingCrew"}`})

	ship, err := client.Ship(scout)

	if err != nil || ship.Status != "awaitingCrew" || ship.Name != "scout" {
		t.Fatalf("ship %+v, %v", ship, err)
	}
}

func TestAShipTheFleetDoesNotKnowIsNotFound(t *testing.T) {
	_, client := aFleetAnswering(t, map[string]string{})

	ship, err := client.Ship(scout)

	if err != nil || ship.Status != "notFound" {
		t.Fatalf("ship %+v, %v", ship, err)
	}
}

func TestAShipIsRegisteredWithTheSecretItsStartingPromptGave(t *testing.T) {
	recorded, client := aFleetAnswering(t, map[string]string{
		"/api/v1/fleet/getStartingPrompt": `{"secret":"aeolus_sk_v1_scout","prompt":"crew scout"}`,
		"/api/v1/ship/register":           `{"crewToken":"aeolus_ct_v1_scout"}`,
	})

	secret, err := client.StartingSecret(scout)
	if err != nil {
		t.Fatal(err)
	}
	crewToken, err := client.RegisterShip(scout, secret, "claude-code")

	if err != nil || crewToken != "aeolus_ct_v1_scout" {
		t.Fatalf("crew token %q, %v", crewToken, err)
	}
	sameJSON(t, recorded.asked["/api/v1/ship/register"], `{"shipId":"`+scout+`","secret":"aeolus_sk_v1_scout","harness":"claude-code","location":{"kind":"DEVICE"}}`)
	if recorded.bearers["/api/v1/ship/register"] != "" {
		t.Fatalf("register carried a crew token: %q", recorded.bearers["/api/v1/ship/register"])
	}
}

func TestAStatusIsWrittenWithItsAttemptAndWhenItsSessionStarted(t *testing.T) {
	recorded, client := aFleetAnswering(t, map[string]string{"/api/v1/fleet/reportCrewStatus": `{}`})

	if err := client.WriteStatus(scout, "running", 1, "2026-11-04T10:00:00.000Z"); err != nil {
		t.Fatal(err)
	}
	sameJSON(t, recorded.asked["/api/v1/fleet/reportCrewStatus"], `{"shipId":"`+scout+`","status":"running","attempt":1,"startedAt":"2026-11-04T10:00:00.000Z"}`)
}

func TestAStatusWithNoSessionRunningSaysNullForItsStart(t *testing.T) {
	recorded, client := aFleetAnswering(t, map[string]string{"/api/v1/fleet/reportCrewStatus": `{}`})

	if err := client.WriteStatus(scout, "crewing", 0, ""); err != nil {
		t.Fatal(err)
	}
	sameJSON(t, recorded.asked["/api/v1/fleet/reportCrewStatus"], `{"shipId":"`+scout+`","status":"crewing","attempt":0,"startedAt":null}`)
}

func TestAReleaseIsConfirmedAfterTheLeaseEnds(t *testing.T) {
	recorded, client := aFleetAnswering(t, map[string]string{"/api/v1/fleet/release": `{}`, "/api/v1/fleet/confirmCrewRelease": `{}`})

	if err := client.Release(scout); err != nil {
		t.Fatal(err)
	}
	if err := client.ConfirmRelease(scout); err != nil {
		t.Fatal(err)
	}
	sameJSON(t, recorded.asked["/api/v1/fleet/release"], `{"shipId":"`+scout+`"}`)
	sameJSON(t, recorded.asked["/api/v1/fleet/confirmCrewRelease"], `{"shipId":"`+scout+`"}`)
}

func TestARequestIsGivenBackWithItsVersionAndWhy(t *testing.T) {
	recorded, client := aFleetAnswering(t, map[string]string{"/api/v1/fleet/giveBackCrewRequest": `{}`})

	if err := client.GiveBack(scout, 3, "harness: codex is not offered on this machine"); err != nil {
		t.Fatal(err)
	}
	sameJSON(t, recorded.asked["/api/v1/fleet/giveBackCrewRequest"], `{"shipId":"`+scout+`","settingsVersion":3,"reason":"harness: codex is not offered on this machine"}`)
}

func TestAReportOnAShipsBehalfCarriesItsSessionsCrewToken(t *testing.T) {
	recorded, client := aFleetAnswering(t, map[string]string{"/api/v1/ship/report": `{}`})

	if err := client.ReportFor("aeolus_ct_v1_scout", "blocked", "blocked: session crashed, restarting"); err != nil {
		t.Fatal(err)
	}
	sameJSON(t, recorded.asked["/api/v1/ship/report"], `{"state":"blocked","note":"blocked: session crashed, restarting"}`)
	if recorded.bearers["/api/v1/ship/report"] != "Bearer aeolus_ct_v1_scout" {
		t.Fatalf("bearer %q", recorded.bearers["/api/v1/ship/report"])
	}
}

func TestACoreAtLeastTheMinimumIsAccepted(t *testing.T) {
	_, client := aFleetAnswering(t, map[string]string{"/api/version": `{"server":"0.35.0"}`})

	if refusal := CoreVersionRefusal(client.URL, "1.0.0", "0.35.0"); refusal != "" {
		t.Fatal(refusal)
	}
}

func TestACoreBuiltFromMainIsAccepted(t *testing.T) {
	_, client := aFleetAnswering(t, map[string]string{"/api/version": `{"server":"0.0.0"}`})

	if refusal := CoreVersionRefusal(client.URL, "1.0.0", "0.35.0"); refusal != "" {
		t.Fatal(refusal)
	}
}

func TestAnOlderCoreIsRefusedNamingBothVersions(t *testing.T) {
	_, client := aFleetAnswering(t, map[string]string{"/api/version": `{"server":"0.34.9"}`})

	refusal := CoreVersionRefusal(client.URL, "1.0.0", "0.35.0")

	want := "trierarch 1.0.0 needs core 0.35.0 or later; the fleet at " + client.URL + " runs core 0.34.9: upgrade core first"
	if refusal != want {
		t.Fatalf("refusal %q, want %q", refusal, want)
	}
}

func TestACoreThatSaysNoVersionIsRefused(t *testing.T) {
	_, client := aFleetAnswering(t, map[string]string{"/api/version": `{"name":"core"}`})

	refusal := CoreVersionRefusal(client.URL, "1.0.0", "0.35.0")

	want := "trierarch 1.0.0 needs core 0.35.0 or later, and could not read the version of the fleet at " + client.URL + ": its /api/version answered no core version"
	if refusal != want {
		t.Fatalf("refusal %q, want %q", refusal, want)
	}
}
