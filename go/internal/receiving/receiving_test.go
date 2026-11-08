package receiving

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/aip"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpservers"
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

// aServerKeeper keeps the MCP servers it is given, or fails to.
type aServerKeeper struct {
	kept []mcpservers.Server
	err  error
	took int
}

func (k *aServerKeeper) Accept(list []mcpservers.Server) error {
	k.took++
	if k.err != nil {
		return k.err
	}
	k.kept = list
	return nil
}

func runKeepingServers(keeper *aServerKeeper, pluginShip string, answers ...answer) *aRun {
	ctx, cancel := context.WithCancel(context.Background())
	ran := &aRun{ship: &aShip{cancel: cancel, answers: answers}}
	Loop{
		Ship:         ran.ship,
		Log:          func(line string) { ran.logged = append(ran.logged, line) },
		Interval:     5 * time.Second,
		KeyWaitMax:   300 * time.Second,
		Pause:        func(_ context.Context, wait time.Duration) { ran.waits = append(ran.waits, wait) },
		PluginShipID: pluginShip,
		McpServers:   keeper,
	}.Run(ctx)
	return ran
}

func aServerList(from string, id string, payload string) Delivery {
	return Delivery{DeliveryID: id, SenderShipID: from, ContentType: mcpservers.ListContentType, Payload: payload}
}

const graph = `{"servers":[{"name":"company-graph","url":"https://graph.example.test/mcp","transport":"streamable-http","tools":["read_neo4j_cypher"]}]}`

func TestTheServerListFromThePluginsShipIsKeptAndAcknowledged(t *testing.T) {
	keeper := &aServerKeeper{}

	ran := runKeepingServers(keeper, plugin, answer{deliveries: []Delivery{aServerList(plugin, "d1", graph)}})

	if len(keeper.kept) != 1 || keeper.kept[0].Name != "company-graph" || !slices.Equal(ran.ship.acked, []string{"d1"}) || len(ran.logged) != 0 {
		t.Fatalf("kept %v, acked %v, logged %q", keeper.kept, ran.ship.acked, ran.logged)
	}
}

func TestAServerListFromAnotherShipIsAcknowledgedAndNotTaken(t *testing.T) {
	keeper := &aServerKeeper{}

	ran := runKeepingServers(keeper, plugin, answer{deliveries: []Delivery{aServerList(argo, "d1", graph)}})

	want := "Not handled: MCP servers from " + argo + ". The trierarch takes them only from the trierarch plugin's ship " + plugin + "."
	if keeper.took != 0 || !slices.Equal(ran.ship.acked, []string{"d1"}) || len(ran.logged) != 1 || ran.logged[0] != want {
		t.Fatalf("took %d, acked %v, logged %q", keeper.took, ran.ship.acked, ran.logged)
	}
}

func TestAServerListOnAMachineThatDoesNotKnowThePluginsShipIsAcknowledgedAndNotTaken(t *testing.T) {
	keeper := &aServerKeeper{}

	ran := runKeepingServers(keeper, "", answer{deliveries: []Delivery{aServerList(plugin, "d1", graph)}})

	if keeper.took != 0 || !slices.Equal(ran.ship.acked, []string{"d1"}) || len(ran.logged) != 1 || !strings.HasPrefix(ran.logged[0], "Not handled: MCP servers from "+plugin+". This machine does not know") {
		t.Fatalf("took %d, acked %v, logged %q", keeper.took, ran.ship.acked, ran.logged)
	}
}

func TestAServerListThatDoesNotFitIsAcknowledgedAndTheHeldListStays(t *testing.T) {
	keeper := &aServerKeeper{kept: []mcpservers.Server{{Name: "company-graph"}}}

	ran := runKeepingServers(keeper, plugin, answer{deliveries: []Delivery{aServerList(plugin, "d1", `{"servers":[{"name":"g","url":"https://t@g.example.test/mcp","transport":"streamable-http","tools":["t"]}]}`)}})

	if keeper.took != 0 || len(keeper.kept) != 1 || !slices.Equal(ran.ship.acked, []string{"d1"}) || len(ran.logged) != 1 || !strings.HasSuffix(ran.logged[0], "The trierarch keeps the list it holds.") {
		t.Fatalf("took %d, kept %v, acked %v, logged %q", keeper.took, keeper.kept, ran.ship.acked, ran.logged)
	}
}

func TestAServerListThatCannotBeKeptIsNotAcknowledgedSoItComesAgain(t *testing.T) {
	keeper := &aServerKeeper{err: errors.New("the file cannot be written")}

	ran := runKeepingServers(keeper, plugin, answer{deliveries: []Delivery{aServerList(plugin, "d1", graph)}})

	if len(ran.ship.acked) != 0 {
		t.Fatalf("acked %v, want none", ran.ship.acked)
	}
}

// aSecretKeeper keeps the secrets it is given, or fails to.
type aSecretKeeper struct {
	kept map[string]string
	err  error
	took int
}

func (k *aSecretKeeper) Accept(held map[string]string) error {
	k.took++
	if k.err != nil {
		return k.err
	}
	k.kept = held
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

// sealedSecrets is the message the trierarch plugin sends: each value sealed to the public key with libsodium's crypto_box_seal.
func sealedSecrets(t *testing.T, public string, values map[string]string) string {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(public)
	if err != nil {
		t.Fatal(err)
	}
	var recipient [32]byte
	copy(recipient[:], raw)
	entries := []map[string]string{}
	for name, value := range values {
		sealed, err := box.SealAnonymous(nil, []byte(value), &recipient, rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, map[string]string{"name": name, "sealed": base64.StdEncoding.EncodeToString(sealed)})
	}
	text, err := json.Marshal(map[string]any{"publicKey": public, "secrets": entries})
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func runKeepingSecrets(keeper *aSecretKeeper, key secrets.Key, answers ...answer) *aRun {
	ctx, cancel := context.WithCancel(context.Background())
	ran := &aRun{ship: &aShip{cancel: cancel, answers: answers}}
	Loop{
		Ship:         ran.ship,
		Log:          func(line string) { ran.logged = append(ran.logged, line) },
		Interval:     5 * time.Second,
		KeyWaitMax:   300 * time.Second,
		Pause:        func(_ context.Context, wait time.Duration) { ran.waits = append(ran.waits, wait) },
		PluginShipID: plugin,
		Secrets:      keeper,
		SealingKey:   key,
	}.Run(ctx)
	return ran
}

func someSecrets(from string, id string, payload string) Delivery {
	return Delivery{DeliveryID: id, SenderShipID: from, ContentType: secrets.ContentType, Payload: payload}
}

func TestTheSecretsFromThePluginsShipAreOpenedKeptAndAcknowledged(t *testing.T) {
	key := aSealingKey(t)
	keeper := &aSecretKeeper{}

	ran := runKeepingSecrets(keeper, key, answer{deliveries: []Delivery{someSecrets(plugin, "d1", sealedSecrets(t, key.Public(), map[string]string{"graph-token": "Bearer s3cr3t"}))}})

	if keeper.kept["graph-token"] != "Bearer s3cr3t" || !slices.Equal(ran.ship.acked, []string{"d1"}) || len(ran.logged) != 0 {
		t.Fatalf("kept %d, acked %v, logged %q", len(keeper.kept), ran.ship.acked, ran.logged)
	}
}

func TestSecretsFromAnotherShipAreAcknowledgedAndNotTaken(t *testing.T) {
	key := aSealingKey(t)
	keeper := &aSecretKeeper{}

	ran := runKeepingSecrets(keeper, key, answer{deliveries: []Delivery{someSecrets(argo, "d1", sealedSecrets(t, key.Public(), map[string]string{"g": "s3cr3t"}))}})

	want := "Not handled: secrets from " + argo + ". The trierarch takes them only from the trierarch plugin's ship " + plugin + "."
	if keeper.took != 0 || !slices.Equal(ran.ship.acked, []string{"d1"}) || len(ran.logged) != 1 || ran.logged[0] != want {
		t.Fatalf("took %d, acked %v, logged %q", keeper.took, ran.ship.acked, ran.logged)
	}
}

func TestSecretsSealedToAnotherKeyAreAcknowledgedAndTheHeldOnesStay(t *testing.T) {
	key := aSealingKey(t)
	other := aSealingKey(t)
	keeper := &aSecretKeeper{kept: map[string]string{"g": "held"}}

	ran := runKeepingSecrets(keeper, key, answer{deliveries: []Delivery{someSecrets(plugin, "d1", sealedSecrets(t, other.Public(), map[string]string{"g": "s3cr3t"}))}})

	if keeper.took != 0 || keeper.kept["g"] != "held" || !slices.Equal(ran.ship.acked, []string{"d1"}) || len(ran.logged) != 1 || !strings.HasSuffix(ran.logged[0], "The trierarch keeps the secrets it holds.") || strings.Contains(ran.logged[0], "s3cr3t") {
		t.Fatalf("took %d, acked %v, logged %q", keeper.took, ran.ship.acked, ran.logged)
	}
}

func TestSecretsThatCannotBeKeptAreNotAcknowledgedSoTheyComeAgain(t *testing.T) {
	key := aSealingKey(t)
	keeper := &aSecretKeeper{err: errors.New("the file cannot be written")}

	ran := runKeepingSecrets(keeper, key, answer{deliveries: []Delivery{someSecrets(plugin, "d1", sealedSecrets(t, key.Public(), map[string]string{"g": "s3cr3t"}))}})

	if len(ran.ship.acked) != 0 || slices.ContainsFunc(ran.logged, func(line string) bool { return strings.Contains(line, "s3cr3t") }) {
		t.Fatalf("acked %v, logged %q, want none acked and no value logged", ran.ship.acked, ran.logged)
	}
}

// anAipKeeper keeps the aip setting it is given, or fails to.
type anAipKeeper struct {
	kept *aip.Setting
	err  error
	took int
}

func (k *anAipKeeper) Accept(setting aip.Setting) error {
	k.took++
	if k.err != nil {
		return k.err
	}
	k.kept = &setting
	return nil
}

func runKeepingAip(keeper *anAipKeeper, answers ...answer) *aRun {
	ctx, cancel := context.WithCancel(context.Background())
	ran := &aRun{ship: &aShip{cancel: cancel, answers: answers}}
	Loop{
		Ship:         ran.ship,
		Log:          func(line string) { ran.logged = append(ran.logged, line) },
		Interval:     5 * time.Second,
		KeyWaitMax:   300 * time.Second,
		Pause:        func(_ context.Context, wait time.Duration) { ran.waits = append(ran.waits, wait) },
		PluginShipID: plugin,
		Aip:          keeper,
	}.Run(ctx)
	return ran
}

func anAipSetting(from string, id string, payload string) Delivery {
	return Delivery{DeliveryID: id, SenderShipID: from, ContentType: aip.ContentType, Payload: payload}
}

const companyAip = `{"server":"https://aip.example.test","tokenSecret":"aip-read"}`

func TestTheAipSettingFromThePluginsShipIsKeptAndAcknowledged(t *testing.T) {
	keeper := &anAipKeeper{}

	ran := runKeepingAip(keeper, answer{deliveries: []Delivery{anAipSetting(plugin, "d1", companyAip)}})

	want := aip.Setting{Server: "https://aip.example.test", TokenSecret: "aip-read"}
	if keeper.kept == nil || *keeper.kept != want || !slices.Equal(ran.ship.acked, []string{"d1"}) || len(ran.logged) != 0 {
		t.Fatalf("kept %+v, acked %v, logged %q", keeper.kept, ran.ship.acked, ran.logged)
	}
}

func TestAnAipSettingFromAnotherShipIsAcknowledgedAndNotTaken(t *testing.T) {
	keeper := &anAipKeeper{}

	ran := runKeepingAip(keeper, answer{deliveries: []Delivery{anAipSetting(argo, "d1", companyAip)}})

	want := "Not handled: an aip setting from " + argo + ". The trierarch takes them only from the trierarch plugin's ship " + plugin + "."
	if keeper.took != 0 || !slices.Equal(ran.ship.acked, []string{"d1"}) || len(ran.logged) != 1 || ran.logged[0] != want {
		t.Fatalf("took %d, acked %v, logged %q", keeper.took, ran.ship.acked, ran.logged)
	}
}

func TestAnAipSettingThatDoesNotFitIsAcknowledgedAndTheHeldOneStays(t *testing.T) {
	keeper := &anAipKeeper{}

	ran := runKeepingAip(keeper, answer{deliveries: []Delivery{anAipSetting(plugin, "d1", `{"server":"https://aip.example.test","tokenSecret":"aip-read","token":"s3cr3t"}`)}})

	if keeper.took != 0 || !slices.Equal(ran.ship.acked, []string{"d1"}) || len(ran.logged) != 1 || !strings.HasSuffix(ran.logged[0], "The trierarch keeps the aip setting it holds.") || strings.Contains(ran.logged[0], "s3cr3t") {
		t.Fatalf("took %d, acked %v, logged %q", keeper.took, ran.ship.acked, ran.logged)
	}
}

func TestAnAipSettingThatCannotBeKeptIsNotAcknowledgedSoItComesAgain(t *testing.T) {
	keeper := &anAipKeeper{err: errors.New("the file cannot be written")}

	ran := runKeepingAip(keeper, answer{deliveries: []Delivery{anAipSetting(plugin, "d1", companyAip)}})

	if len(ran.ship.acked) != 0 {
		t.Fatalf("acked %v, want none", ran.ship.acked)
	}
}
