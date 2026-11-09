package receiving

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpconfiguration"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/secrets"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/trusted"
	"golang.org/x/crypto/nacl/box"
)

const argo = "shp_01m6jyczpnpp5c0vxh54c966cy"

// aShip is the trierarch's own ship: what it is sent to receive, one answer per receive, and what it acknowledged and answered with pong.
type aShip struct {
	cancel  context.CancelFunc
	answers []answer
	acked   []string
	ponged  []string
	ackErr  error
}

type answer struct {
	deliveries []Delivery
	err        error
	// isStop stops the loop as this answer comes.
	isStop bool
}

// Receive answers the next answer; once they are all given it stops the loop.
func (s *aShip) Receive(ctx context.Context) ([]Delivery, error) {
	if len(s.answers) == 0 {
		s.cancel()
		return nil, ctx.Err()
	}
	next := s.answers[0]
	s.answers = s.answers[1:]
	if next.isStop {
		s.cancel()
	}
	return next.deliveries, next.err
}

func (s *aShip) Ack(deliveryID string) error {
	s.acked = append(s.acked, deliveryID)
	return s.ackErr
}

func (s *aShip) Pong(deliveryID string) error {
	s.ponged = append(s.ponged, deliveryID)
	return nil
}

type aRun struct {
	ship    *aShip
	logged  []string
	waits   []time.Duration
	cutOffs []bool
}

// runWith runs the loop until the ship has given every answer.
func runWith(answers ...answer) *aRun {
	ctx, cancel := context.WithCancel(context.Background())
	ran := &aRun{ship: &aShip{cancel: cancel, answers: answers}}
	Loop{
		Ship:        ran.ship,
		Log:         func(line string) { ran.logged = append(ran.logged, line) },
		Interval:    5 * time.Second,
		KeyWaitMax:  300 * time.Second,
		Pause:       func(_ context.Context, wait time.Duration) { ran.waits = append(ran.waits, wait) },
		OnKeyCutOff: func(isCutOff bool) { ran.cutOffs = append(ran.cutOffs, isCutOff) },
	}.Run(ctx)
	return ran
}

func a(contentType string, id string) Delivery {
	return Delivery{DeliveryID: id, SenderShipID: argo, ContentType: contentType}
}

func aKeyCutOff() answer {
	return answer{err: &Refusal{Code: "KEY_UNAVAILABLE", Message: "the key cannot be had"}}
}

func TestAPingGetsPongAndIsNotAcknowledged(t *testing.T) {
	ran := runWith(answer{deliveries: []Delivery{a("application/vnd.aeolus.ping", "d1")}})

	if !slices.Equal(ran.ship.ponged, []string{"d1"}) || len(ran.ship.acked) != 0 {
		t.Fatalf("ponged %v, acked %v", ran.ship.ponged, ran.ship.acked)
	}
}

func TestAPingIsToldByItsMediaTypeWithoutCaseAndParameters(t *testing.T) {
	ran := runWith(answer{deliveries: []Delivery{a(" Application/Vnd.Aeolus.Ping ; charset=utf-8", "d1")}})

	if !slices.Equal(ran.ship.ponged, []string{"d1"}) {
		t.Fatalf("ponged %v", ran.ship.ponged)
	}
}

func TestAnyOtherDeliveryIsAcknowledgedAndLoggedAsNotHandled(t *testing.T) {
	ran := runWith(answer{deliveries: []Delivery{a("text/markdown", "d1"), a("text/plain", "d2")}})

	if !slices.Equal(ran.ship.acked, []string{"d1", "d2"}) || len(ran.ship.ponged) != 0 {
		t.Fatalf("acked %v, ponged %v", ran.ship.acked, ran.ship.ponged)
	}
	want := "Not handled: text/markdown from " + argo + ". A trierarch takes work only through the crew requests assigned to it."
	if ran.logged[0] != want {
		t.Fatalf("logged %q", ran.logged)
	}
}

func TestAFailureIsLoggedAndTheLoopWaitsAnIntervalAndGoesOn(t *testing.T) {
	ran := runWith(answer{err: errors.New("the fleet at http://f cannot be reached")}, answer{deliveries: []Delivery{a("text/markdown", "d1")}})

	if ran.logged[0] != "The loop failed and goes on: the fleet at http://f cannot be reached" || !slices.Equal(ran.waits, []time.Duration{5 * time.Second}) {
		t.Fatalf("logged %q, waited %v", ran.logged, ran.waits)
	}
	if !slices.Equal(ran.ship.acked, []string{"d1"}) {
		t.Fatalf("acked %v", ran.ship.acked)
	}
}

func TestAFailedAcknowledgementIsAFailureOfTheLoop(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	ship := &aShip{cancel: cancel, answers: []answer{{deliveries: []Delivery{a("text/markdown", "d1")}}}, ackErr: errors.New("ack refused")}
	logged := []string{}

	Loop{Ship: ship, Log: func(line string) { logged = append(logged, line) }, Interval: time.Second, KeyWaitMax: time.Minute, Pause: func(context.Context, time.Duration) {}}.Run(ctx)

	if !slices.Contains(logged, "The loop failed and goes on: ack refused") {
		t.Fatalf("logged %q", logged)
	}
}

func TestWhileTheKeyIsCutOffTheWaitDoublesUpToTheMaximumAndItIsSaidOnce(t *testing.T) {
	answers := []answer{}
	for range 9 {
		answers = append(answers, aKeyCutOff())
	}

	ran := runWith(answers...)

	want := []time.Duration{5, 10, 20, 40, 80, 160, 300, 300, 300}
	for i := range want {
		want[i] *= time.Second
	}
	if !slices.Equal(ran.waits, want) {
		t.Fatalf("waited %v", ran.waits)
	}
	if !slices.Equal(ran.cutOffs, []bool{true}) {
		t.Fatalf("told %v", ran.cutOffs)
	}
	said := 0
	for _, line := range ran.logged {
		if strings.HasPrefix(line, "The fleet's key is not reachable, so the trierarch's own ship receives nothing and waits, longer each time, up to 300000 ms: the key cannot be had") {
			said++
		}
	}
	if said != 1 || len(ran.logged) != 1 {
		t.Fatalf("logged %q", ran.logged)
	}
}

func TestWhenTheKeyIsBackItIsSaidAndTheNextCutOffStartsAtAnInterval(t *testing.T) {
	ran := runWith(aKeyCutOff(), aKeyCutOff(), answer{}, aKeyCutOff())

	if !slices.Equal(ran.waits, []time.Duration{5 * time.Second, 10 * time.Second, 5 * time.Second}) {
		t.Fatalf("waited %v", ran.waits)
	}
	if !slices.Equal(ran.cutOffs, []bool{true, false, true}) {
		t.Fatalf("told %v", ran.cutOffs)
	}
	if !slices.Contains(ran.logged, "The fleet's key is reachable again: the trierarch's own ship receives again") {
		t.Fatalf("logged %q", ran.logged)
	}
}

func TestAFailureThatComesWithTheStopIsNotLoggedAndEndsTheLoop(t *testing.T) {
	ran := runWith(answer{err: errors.New("context canceled"), isStop: true})

	if len(ran.logged) != 0 || len(ran.waits) != 0 {
		t.Fatalf("logged %q, waited %v", ran.logged, ran.waits)
	}
}

const plugin = "shp_01m6jyczpnpp5c0vxh54c966cz"

// aKeeper keeps what it is given, or fails to.
type aKeeper struct {
	kept []trusted.Repository
	err  error
	took int
}

func (k *aKeeper) Accept(list []trusted.Repository) error {
	k.took++
	if k.err != nil {
		return k.err
	}
	k.kept = list
	return nil
}

// runKeeping runs the loop of a machine that knows the plugin's ship (when pluginShip is set) and keeps the trusted repositories.
func runKeeping(keeper *aKeeper, pluginShip string, answers ...answer) *aRun {
	ctx, cancel := context.WithCancel(context.Background())
	ran := &aRun{ship: &aShip{cancel: cancel, answers: answers}}
	Loop{
		Ship:         ran.ship,
		Log:          func(line string) { ran.logged = append(ran.logged, line) },
		Interval:     5 * time.Second,
		KeyWaitMax:   300 * time.Second,
		Pause:        func(_ context.Context, wait time.Duration) { ran.waits = append(ran.waits, wait) },
		PluginShipID: pluginShip,
		Trusted:      keeper,
	}.Run(ctx)
	return ran
}

func aList(from string, id string, payload string) Delivery {
	return Delivery{DeliveryID: id, SenderShipID: from, ContentType: trusted.ListContentType, Payload: payload}
}

const hemma = `{"repositories":[{"name":"hemma","url":"git@github.com:a/hemma.git"}]}`

func TestTheListFromThePluginsShipIsKeptAndAcknowledged(t *testing.T) {
	keeper := &aKeeper{}

	ran := runKeeping(keeper, plugin, answer{deliveries: []Delivery{aList(plugin, "d1", hemma)}})

	if len(keeper.kept) != 1 || keeper.kept[0].Name != "hemma" || !slices.Equal(ran.ship.acked, []string{"d1"}) || len(ran.logged) != 0 {
		t.Fatalf("kept %v, acked %v, logged %q", keeper.kept, ran.ship.acked, ran.logged)
	}
}

func TestAnEmptyListFromThePluginsShipIsKept(t *testing.T) {
	keeper := &aKeeper{kept: []trusted.Repository{{Name: "hemma", URL: "git@github.com:a/hemma.git"}}}

	runKeeping(keeper, plugin, answer{deliveries: []Delivery{aList(plugin, "d1", `{"repositories":[]}`)}})

	if keeper.took != 1 || len(keeper.kept) != 0 {
		t.Fatalf("kept %v after %d takes", keeper.kept, keeper.took)
	}
}

func TestAListFromAnotherShipIsAcknowledgedLoggedAsNotHandledAndNotKept(t *testing.T) {
	keeper := &aKeeper{}

	ran := runKeeping(keeper, plugin, answer{deliveries: []Delivery{aList(argo, "d1", hemma)}})

	want := "Not handled: trusted repositories from " + argo + ". The trierarch takes them only from the trierarch plugin's ship " + plugin + "."
	if keeper.took != 0 || !slices.Equal(ran.ship.acked, []string{"d1"}) || len(ran.logged) != 1 || ran.logged[0] != want {
		t.Fatalf("took %d, acked %v, logged %q", keeper.took, ran.ship.acked, ran.logged)
	}
}

func TestAListOnAMachineThatDoesNotKnowThePluginsShipIsAcknowledgedAndNotKept(t *testing.T) {
	keeper := &aKeeper{}

	ran := runKeeping(keeper, "", answer{deliveries: []Delivery{aList(plugin, "d1", hemma)}})

	want := "Not handled: trusted repositories from " + plugin + ". This machine does not know the trierarch plugin's ship: run aeolus-trierarch init --plugin-ship-id <its ship id>."
	if keeper.took != 0 || !slices.Equal(ran.ship.acked, []string{"d1"}) || len(ran.logged) != 1 || ran.logged[0] != want {
		t.Fatalf("took %d, acked %v, logged %q", keeper.took, ran.ship.acked, ran.logged)
	}
}

func TestAListThatDoesNotFitIsAcknowledgedAndTheHeldListStays(t *testing.T) {
	held := []trusted.Repository{{Name: "hemma", URL: "git@github.com:a/hemma.git"}}
	keeper := &aKeeper{kept: held}

	ran := runKeeping(keeper, plugin, answer{deliveries: []Delivery{aList(plugin, "d1", `{"repositories":[{"name":"hemma","url":"https://token@github.com/a/hemma.git"}]}`)}})

	want := "Not handled: trusted repositories that do not fit (hemma: a trusted repository is an https:// or ssh URL, never a path, a file URL or a credential). The trierarch keeps the list it holds."
	if keeper.took != 0 || len(keeper.kept) != 1 || !slices.Equal(ran.ship.acked, []string{"d1"}) || len(ran.logged) != 1 || ran.logged[0] != want {
		t.Fatalf("took %d, kept %v, acked %v, logged %q", keeper.took, keeper.kept, ran.ship.acked, ran.logged)
	}
}

func TestAListThatCannotBeKeptIsNotAcknowledgedSoItComesAgain(t *testing.T) {
	keeper := &aKeeper{err: errors.New("Claude Code's file cannot be written")}

	ran := runKeeping(keeper, plugin, answer{deliveries: []Delivery{aList(plugin, "d1", hemma)}})

	if len(ran.ship.acked) != 0 || !slices.Contains(ran.logged, "The loop failed and goes on: Claude Code's file cannot be written") {
		t.Fatalf("acked %v, logged %q", ran.ship.acked, ran.logged)
	}
}

const fleet = "flt_01m3tb1zgr5h2ffee12xnch8sv"

var identity = mcpconfiguration.Identity{FleetID: fleet, PluginShipID: plugin}

// aConfirmer is the trierarch's own ship confirming an applied configuration to the plugin ship: what it sent, or its failure.
type aConfirmer struct {
	sent []string
	to   []string
	err  error
}

func (c *aConfirmer) ConfirmMcpConfiguration(pluginShipID string, payload string) error {
	if c.err != nil {
		return c.err
	}
	c.to = append(c.to, pluginShipID)
	c.sent = append(c.sent, payload)
	return nil
}

func aSealingKey(t *testing.T) secrets.Key {
	t.Helper()
	key, err := secrets.LoadOrMake(filepath.Join(t.TempDir(), "sealing-key"))
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// aConfigurationOf is the configuration message the plugin ship sends: of the fleet, at the version, with company-graph when isWithGraph, its secret sealed to the public key with libsodium's crypto_box_seal.
func aConfigurationOf(t *testing.T, fleetID string, version int, public string, isWithGraph bool) string {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(public)
	if err != nil {
		t.Fatal(err)
	}
	var recipient [32]byte
	copy(recipient[:], raw)
	servers, entries := []any{}, []map[string]string{}
	if isWithGraph {
		sealed, err := box.SealAnonymous(nil, []byte("Bearer abc"), &recipient, rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		servers = append(servers, json.RawMessage(`{"name":"company-graph","url":"https://graph.example.test/mcp","tools":["read_neo4j_cypher"],"credential":{"secret":"graph-token","header":"Authorization"}}`))
		entries = append(entries, map[string]string{"name": "graph-token", "sealed": base64.StdEncoding.EncodeToString(sealed)})
	}
	text, err := json.Marshal(map[string]any{"fleetId": fleetID, "pluginShipId": plugin, "version": version, "publicKey": public, "servers": servers, "secrets": entries})
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func aConfiguration(from string, id string, payload string) Delivery {
	return Delivery{DeliveryID: id, SenderShipID: from, ContentType: mcpconfiguration.ContentType, Payload: payload}
}

type aConfigurationRun struct {
	*aRun
	file      *mcpconfiguration.File
	confirmer *aConfirmer
}

// runApplying runs the loop of a machine of the fleet that knows the plugin ship, applying configurations into the file.
func runApplying(t *testing.T, key secrets.Key, file *mcpconfiguration.File, confirmer *aConfirmer, answers ...answer) aConfigurationRun {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	ran := &aRun{ship: &aShip{cancel: cancel, answers: answers}}
	Loop{
		Ship:             ran.ship,
		Log:              func(line string) { ran.logged = append(ran.logged, line) },
		Interval:         5 * time.Second,
		KeyWaitMax:       300 * time.Second,
		Pause:            func(_ context.Context, wait time.Duration) { ran.waits = append(ran.waits, wait) },
		PluginShipID:     plugin,
		McpConfiguration: &McpConfiguration{File: file, Identity: identity, SealingKey: key, Confirm: confirmer},
	}.Run(ctx)
	return aConfigurationRun{aRun: ran, file: file, confirmer: confirmer}
}

func aConfigurationFile(t *testing.T) *mcpconfiguration.File {
	t.Helper()
	file := &mcpconfiguration.File{Path: filepath.Join(t.TempDir(), "mcp-configuration.json")}
	file.Load(identity)
	return file
}

func appliedOf(t *testing.T, version int, public string) string {
	t.Helper()
	text, err := json.Marshal(map[string]any{"fleetId": fleet, "pluginShipId": plugin, "version": version, "publicKey": public})
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func sameJSON(t *testing.T, got []string, want []string) bool {
	t.Helper()
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		var left, right any
		if json.Unmarshal([]byte(got[index]), &left) != nil || json.Unmarshal([]byte(want[index]), &right) != nil {
			return false
		}
		leftText, _ := json.Marshal(left)
		rightText, _ := json.Marshal(right)
		if string(leftText) != string(rightText) {
			return false
		}
	}
	return true
}

func TestAConfigurationFromThePluginShipIsAppliedConfirmedAndThenAcknowledged(t *testing.T) {
	key := aSealingKey(t)

	ran := runApplying(t, key, aConfigurationFile(t), &aConfirmer{}, answer{deliveries: []Delivery{aConfiguration(plugin, "d1", aConfigurationOf(t, fleet, 3, key.Public(), true))}})

	held, ok := ran.file.Current()
	if !ok || held.Version != 3 || len(held.Servers) != 1 || held.Secrets["graph-token"] != "Bearer abc" || !slices.Equal(ran.ship.acked, []string{"d1"}) {
		t.Fatalf("held %+v, %v, acked %v, want version 3 applied and acknowledged", held, ok, ran.ship.acked)
	}
	if !slices.Equal(ran.confirmer.to, []string{plugin}) || !sameJSON(t, ran.confirmer.sent, []string{appliedOf(t, 3, key.Public())}) {
		t.Fatalf("confirmed %v to %v, want version 3 and the key to the plugin ship", ran.confirmer.sent, ran.confirmer.to)
	}
}

func TestADuplicateConfigurationIsConfirmedAgainAndChangesNothing(t *testing.T) {
	key := aSealingKey(t)
	payload := aConfigurationOf(t, fleet, 3, key.Public(), true)

	ran := runApplying(t, key, aConfigurationFile(t), &aConfirmer{}, answer{deliveries: []Delivery{aConfiguration(plugin, "d1", payload), aConfiguration(plugin, "d2", payload)}})

	if !sameJSON(t, ran.confirmer.sent, []string{appliedOf(t, 3, key.Public()), appliedOf(t, 3, key.Public())}) || !slices.Equal(ran.ship.acked, []string{"d1", "d2"}) {
		t.Fatalf("confirmed %v, acked %v, want version 3 confirmed twice", ran.confirmer.sent, ran.ship.acked)
	}
}

func TestAnOlderConfigurationIsAcknowledgedNotAppliedAndNotConfirmed(t *testing.T) {
	key := aSealingKey(t)

	ran := runApplying(t, key, aConfigurationFile(t), &aConfirmer{}, answer{deliveries: []Delivery{aConfiguration(plugin, "d1", aConfigurationOf(t, fleet, 4, key.Public(), false)), aConfiguration(plugin, "d2", aConfigurationOf(t, fleet, 3, key.Public(), true))}})

	held, _ := ran.file.Current()
	if held.Version != 4 || len(held.Servers) != 0 || !sameJSON(t, ran.confirmer.sent, []string{appliedOf(t, 4, key.Public())}) || !slices.Equal(ran.ship.acked, []string{"d1", "d2"}) {
		t.Fatalf("held %+v, confirmed %v, acked %v, want version 4 alone held and confirmed", held, ran.confirmer.sent, ran.ship.acked)
	}
}

func TestAConfigurationThatDoesNotFitIsAcknowledgedAndChangesNothing(t *testing.T) {
	key := aSealingKey(t)
	other := aSealingKey(t)
	for _, test := range []struct {
		label    string
		delivery Delivery
		logged   string
	}{
		{"from another ship", aConfiguration(argo, "d2", aConfigurationOf(t, fleet, 5, key.Public(), false)), "Not handled: an MCP configuration from " + argo + ". The trierarch takes them only from the trierarch plugin's ship " + plugin + "."},
		{"of another fleet", aConfiguration(plugin, "d2", aConfigurationOf(t, "flt_01m3tb1zgr5h2ffee12xnch8sw", 5, key.Public(), false)), "MCP_CONFIGURATION_IDENTITY_MISMATCH"},
		{"sealed to another key", aConfiguration(plugin, "d2", aConfigurationOf(t, fleet, 5, other.Public(), false)), "The trierarch keeps the MCP configuration it applied."},
	} {
		t.Run(test.label, func(t *testing.T) {
			ran := runApplying(t, key, aConfigurationFile(t), &aConfirmer{}, answer{deliveries: []Delivery{aConfiguration(plugin, "d1", aConfigurationOf(t, fleet, 3, key.Public(), true)), test.delivery}})

			held, _ := ran.file.Current()
			if held.Version != 3 || len(held.Servers) != 1 || len(ran.confirmer.sent) != 1 || !slices.Equal(ran.ship.acked, []string{"d1", "d2"}) {
				t.Fatalf("held %+v, confirmed %v, acked %v, want version 3 kept and confirmed once", held, ran.confirmer.sent, ran.ship.acked)
			}
			if len(ran.logged) != 1 || !strings.Contains(ran.logged[0], test.logged) || strings.Contains(ran.logged[0], "Bearer") {
				t.Fatalf("logged %q, want one value-free line with %q", ran.logged, test.logged)
			}
		})
	}
}

func TestAConfigurationThatCannotBePersistedIsNotConfirmedOrAcknowledgedSoItComesAgain(t *testing.T) {
	key := aSealingKey(t)
	blocked := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(blocked, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	file := &mcpconfiguration.File{Path: filepath.Join(blocked, "mcp-configuration.json")}

	ran := runApplying(t, key, file, &aConfirmer{}, answer{deliveries: []Delivery{aConfiguration(plugin, "d1", aConfigurationOf(t, fleet, 3, key.Public(), true))}})

	if len(ran.ship.acked) != 0 || len(ran.confirmer.sent) != 0 {
		t.Fatalf("acked %v, confirmed %v, want neither", ran.ship.acked, ran.confirmer.sent)
	}
}

func TestAConfigurationWhoseConfirmationFailsIsNotAcknowledgedSoItComesAgain(t *testing.T) {
	key := aSealingKey(t)

	ran := runApplying(t, key, aConfigurationFile(t), &aConfirmer{err: errors.New("the fleet cannot be reached")}, answer{deliveries: []Delivery{aConfiguration(plugin, "d1", aConfigurationOf(t, fleet, 3, key.Public(), true))}})

	if len(ran.ship.acked) != 0 {
		t.Fatalf("acked %v, want none", ran.ship.acked)
	}
}

func TestTheOldServerListAndSecretsMessagesAreAcknowledgedAsNotHandled(t *testing.T) {
	key := aSealingKey(t)
	old := []Delivery{
		{DeliveryID: "d1", SenderShipID: plugin, ContentType: "application/vnd.aeolus.trierarch.mcp-servers+json", Payload: `{"servers":[]}`},
		{DeliveryID: "d2", SenderShipID: plugin, ContentType: "application/vnd.aeolus.trierarch.secrets+json", Payload: `{"publicKey":"` + key.Public() + `","secrets":[]}`},
	}

	ran := runApplying(t, key, aConfigurationFile(t), &aConfirmer{}, answer{deliveries: old})

	if _, ok := ran.file.Current(); ok || len(ran.confirmer.sent) != 0 || !slices.Equal(ran.ship.acked, []string{"d1", "d2"}) || len(ran.logged) != 2 || !strings.HasPrefix(ran.logged[0], "Not handled: application/vnd.aeolus.trierarch.mcp-servers+json") {
		t.Fatalf("acked %v, confirmed %v, logged %q, want both acknowledged as not handled", ran.ship.acked, ran.confirmer.sent, ran.logged)
	}
}
