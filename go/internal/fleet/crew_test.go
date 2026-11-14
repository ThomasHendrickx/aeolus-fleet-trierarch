package fleet

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
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
		body, _ := io.ReadAll(r.Body)
		recorded.asked[r.URL.Path] = r.Method + " " + string(body)
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

	refusal, err := client.GiveBack(scout, 3, "harness: codex is not offered on this machine")
	if err != nil || refusal != nil {
		t.Fatal(refusal, err)
	}
	sameJSON(t, recorded.asked["/api/v1/fleet/giveBackCrewRequest"], `{"shipId":"`+scout+`","settingsVersion":3,"reason":"harness: codex is not offered on this machine"}`)
}

func TestAGiveBackTheFleetRefusesIsAnsweredAsTheRefusalNotAsAFailure(t *testing.T) {
	_, client := aFleetAnswering(t, map[string]string{})

	refusal, err := client.GiveBack(scout, 3, "harness: codex is not offered on this machine")

	if err != nil || refusal == nil || refusal.Code != "NOT_FOUND" {
		t.Fatalf("refusal %+v, error %v", refusal, err)
	}
}

func TestTheTrierarchsNameIsWhatTheFleetKnowsItBy(t *testing.T) {
	recorded, client := aFleetAnswering(t, map[string]string{"/api/v1/ship/whoami": `{"shipId":"` + scout + `","name":"mac-mini"}`})

	name, err := client.Name()

	if err != nil || name != "mac-mini" {
		t.Fatalf("name %q, error %v", name, err)
	}
	if recorded.bearers["/api/v1/ship/whoami"] != "Bearer aeolus_ct_v1_trierarch" {
		t.Fatalf("bearer %q", recorded.bearers["/api/v1/ship/whoami"])
	}
}

func TestTheTrierarchsFleetIsTheOneTheFleetSaysItIsIn(t *testing.T) {
	_, client := aFleetAnswering(t, map[string]string{"/api/v1/ship/whoami": `{"shipId":"` + scout + `","fleetId":"flt_01m3tb1zgr5h2ffee12xnch8sv","name":"mac-mini"}`})

	fleetID, err := client.FleetID()

	if err != nil || fleetID != "flt_01m3tb1zgr5h2ffee12xnch8sv" {
		t.Fatalf("FleetID() = %q, %v, want the fleet whoami names", fleetID, err)
	}
}

func TestATrierarchWhoseFleetIsNotNamedHasNone(t *testing.T) {
	_, client := aFleetAnswering(t, map[string]string{"/api/v1/ship/whoami": `{"shipId":"` + scout + `","name":"mac-mini"}`})

	if fleetID, err := client.FleetID(); err == nil {
		t.Fatalf("FleetID() = %q, want an error when whoami names no fleet", fleetID)
	}
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

func TestTheTrierarchReportsAsItsOwnShipWithItsOwnCrewToken(t *testing.T) {
	recorded, client := aFleetAnswering(t, map[string]string{"/api/v1/ship/report": `{}`})

	if err := client.ReportSelf("idle", "0 of 8 running", map[string]any{"version": "0.40.0"}); err != nil {
		t.Fatal(err)
	}
	sameJSON(t, recorded.asked["/api/v1/ship/report"], `{"state":"idle","note":"0 of 8 running","details":{"version":"0.40.0"}}`)
	if recorded.bearers["/api/v1/ship/report"] != "Bearer aeolus_ct_v1_trierarch" {
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

func TestASessionsInboxIsAskedWithItsCrewToken(t *testing.T) {
	recorded, client := aFleetAnswering(t, map[string]string{"/api/v1/ship/inbox": `{"waiting":3,"forced":1}`})

	inbox, err := client.Inbox("aeolus_ct_v1_scout")

	if err != nil || inbox != (reconciler.Inbox{Waiting: 3, Forced: 1}) {
		t.Fatalf("Inbox = %+v %v, want 3 waiting, 1 forced", inbox, err)
	}
	if got := recorded.bearers["/api/v1/ship/inbox"]; got != "Bearer aeolus_ct_v1_scout" {
		t.Fatalf("asked with %q, want the session's crew token", got)
	}
}

func TestAnInboxWhoseLeaseEndedSaysSo(t *testing.T) {
	for _, code := range []string{"LEASE_ENDED", "UNAUTHORIZED", "UNKNOWN_CREW_TOKEN"} {
		t.Run(code, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"code":"` + code + `","message":"gone"}`))
			}))
			t.Cleanup(server.Close)

			inbox, err := Client{URL: server.URL}.Inbox("aeolus_ct_v1_scout")

			if err != nil || !inbox.IsLeaseEnded {
				t.Fatalf("Inbox = %+v %v, want the lease ended", inbox, err)
			}
		})
	}
}

func TestTheTrierarchsOwnShipReceivesAtMostTenDeliveriesWithItsCrewToken(t *testing.T) {
	recorded, client := aFleetAnswering(t, map[string]string{"/api/v1/ship/receive": `{"deliveries":[{"deliveryId":"dlv_1","messageId":"msg_1","senderShipId":"` + scout + `","contentType":"application/vnd.aeolus.ping","payload":"ping"}]}`})

	deliveries, err := client.Receive(context.Background())

	if err != nil || len(deliveries) != 1 || deliveries[0].DeliveryID != "dlv_1" || deliveries[0].SenderShipID != scout || deliveries[0].ContentType != "application/vnd.aeolus.ping" || deliveries[0].Payload != "ping" {
		t.Fatalf("deliveries %+v, %v", deliveries, err)
	}
	sameJSON(t, recorded.asked["/api/v1/ship/receive"], `{"max":10}`)
	if recorded.bearers["/api/v1/ship/receive"] != "Bearer aeolus_ct_v1_trierarch" {
		t.Fatalf("bearer %q", recorded.bearers["/api/v1/ship/receive"])
	}
}

func TestADeliveryIsAcknowledgedAndAPingGetsPong(t *testing.T) {
	recorded, client := aFleetAnswering(t, map[string]string{"/api/v1/ship/ack": `{}`, "/api/v1/ship/pong": `{}`})

	if err := client.Ack("dlv_1"); err != nil {
		t.Fatal(err)
	}
	if err := client.Pong("dlv_2"); err != nil {
		t.Fatal(err)
	}

	sameJSON(t, recorded.asked["/api/v1/ship/ack"], `{"deliveryId":"dlv_1"}`)
	sameJSON(t, recorded.asked["/api/v1/ship/pong"], `{"deliveryId":"dlv_2"}`)
}

func TestAReceiveTheFleetRefusesIsItsRefusal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"code":"KEY_UNAVAILABLE","message":"the key cannot be had"}`))
	}))
	t.Cleanup(server.Close)

	_, err := Client{URL: server.URL, CrewToken: "t"}.Receive(context.Background())

	var refusal *Refusal
	if !errors.As(err, &refusal) || refusal.Code != "KEY_UNAVAILABLE" {
		t.Fatalf("error %v", err)
	}
}

func TestAReceiveTheFleetHoldsEndsWhenItsContextDoes(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(release) })
	ctx, stop := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, stop)

	_, err := Client{URL: server.URL, CrewToken: "t"}.Receive(ctx)

	if err == nil || ctx.Err() == nil {
		t.Fatalf("error %v", err)
	}
}

func TestThePendingClearRequestsAreReadWithTheTrierarchsCrewToken(t *testing.T) {
	recorded, client := aFleetAnswering(t, map[string]string{"/api/v1/fleet/clearRequests": `[{"trierarchShipId":"shp_trierarch","shipId":"` + scout + `","repository":"aeolus-fleet","requestedBy":"shp_argo","requestedAt":"2026-11-05T10:00:00.000Z"}]`})

	clears, err := client.PendingClears()

	if err != nil {
		t.Fatal(err)
	}
	if want := []reconciler.ClearRequest{{ShipID: scout, Repository: "aeolus-fleet"}}; len(clears) != 1 || clears[0] != want[0] {
		t.Fatalf("clears %+v, want %+v", clears, want)
	}
	if recorded.asked["/api/v1/fleet/clearRequests"] != "GET " || recorded.bearers["/api/v1/fleet/clearRequests"] != "Bearer aeolus_ct_v1_trierarch" {
		t.Fatalf("asked %q with %q", recorded.asked["/api/v1/fleet/clearRequests"], recorded.bearers["/api/v1/fleet/clearRequests"])
	}
}

func TestAClearIsConfirmedWithHowItCameOut(t *testing.T) {
	recorded, client := aFleetAnswering(t, map[string]string{"/api/v1/fleet/confirmWorktreeCleared": `{}`})

	if err := client.ConfirmCleared(scout, "aeolus-fleet", "removed"); err != nil {
		t.Fatal(err)
	}

	sameJSON(t, recorded.asked["/api/v1/fleet/confirmWorktreeCleared"], `{"shipId":"`+scout+`","repository":"aeolus-fleet","outcome":"removed"}`)
	if recorded.bearers["/api/v1/fleet/confirmWorktreeCleared"] != "Bearer aeolus_ct_v1_trierarch" {
		t.Fatalf("confirmed with %q", recorded.bearers["/api/v1/fleet/confirmWorktreeCleared"])
	}
}

func TestAClearTheFleetRefusesIsAFailure(t *testing.T) {
	_, client := aFleetAnswering(t, map[string]string{})

	err := client.ConfirmCleared(scout, "aeolus-fleet", "not-kept")

	var refusal *Refusal
	if !errors.As(err, &refusal) {
		t.Fatalf("err %v, want the fleet's refusal", err)
	}
}
