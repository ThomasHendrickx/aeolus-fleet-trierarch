package mcpconfiguration

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"maps"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/nacl/box"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/secrets"
)

const (
	fleetID      = "flt_01m3tb1zgr5h2ffee12xnch8sv"
	pluginShipID = "shp_01m3tb1zhjs6kthtcs2zvksacv"
	graph        = `{"name":"company-graph","url":"https://graph.example.test/mcp","tools":["read_neo4j_cypher"],"credential":{"secret":"graph-token","header":"Authorization"}}`
)

var configured = Identity{FleetID: fleetID, PluginShipID: pluginShipID}

// aKey is a sealing key made in a folder of its own.
func aKey(t *testing.T) secrets.Key {
	t.Helper()
	key, err := secrets.LoadOrMake(filepath.Join(t.TempDir(), "sealing-key"))
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// sealedTo seals the value to the base64 public key, as the trierarch plugin does with libsodium's crypto_box_seal.
func sealedTo(t *testing.T, public string, value string) string {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(public)
	if err != nil || len(raw) != 32 {
		t.Fatalf("public key %q is not 32 bytes of base64", public)
	}
	var recipient [32]byte
	copy(recipient[:], raw)
	sealed, err := box.SealAnonymous(nil, []byte(value), &recipient, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(sealed)
}

// aMessage is the configuration message's payload as the trierarch plugin writes it, each field changed as change says.
func aMessage(t *testing.T, key secrets.Key, change func(fields map[string]any)) string {
	t.Helper()
	fields := map[string]any{
		"fleetId":      fleetID,
		"pluginShipId": pluginShipID,
		"version":      3,
		"publicKey":    key.Public(),
		"servers":      json.RawMessage("[" + graph + "]"),
		"secrets":      []map[string]string{{"name": "graph-token", "sealed": sealedTo(t, key.Public(), "Bearer abc")}},
	}
	if change != nil {
		change(fields)
	}
	text, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func TestReadTakesTheCompleteConfigurationSealedToThisTrierarch(t *testing.T) {
	key := aKey(t)

	got, err := Read(aMessage(t, key, nil), configured, key)

	if err != nil || got.Identity != configured || got.Version != 3 || got.PublicKey != key.Public() || len(got.Servers) != 1 || got.Servers[0].Name != "company-graph" || !maps.Equal(got.Secrets, map[string]string{"graph-token": "Bearer abc"}) {
		t.Errorf("Read(configuration) = %+v, %v, want version 3 with company-graph and its opened secret", got, err)
	}
}

func TestReadTakesAnEmptyConfiguration(t *testing.T) {
	key := aKey(t)

	got, err := Read(aMessage(t, key, func(fields map[string]any) {
		fields["version"] = 0
		fields["servers"] = []any{}
		fields["secrets"] = []any{}
	}), configured, key)

	if err != nil || got.Version != 0 || len(got.Servers) != 0 || len(got.Secrets) != 0 {
		t.Errorf("Read(empty configuration) = %+v, %v, want version 0 with no server and no secret", got, err)
	}
}

func TestReadRefusesAnotherFleetOrPluginShipAsAnIdentityMismatch(t *testing.T) {
	key := aKey(t)
	for _, test := range []struct{ label, field, value string }{
		{"another fleet", "fleetId", "flt_01m3tb1zgr5h2ffee12xnch8sw"},
		{"another plugin ship", "pluginShipId", "shp_01m3tb1zhjs6kthtcs2zvksacw"},
	} {
		t.Run(test.label, func(t *testing.T) {
			_, err := Read(aMessage(t, key, func(fields map[string]any) { fields[test.field] = test.value }), configured, key)

			if !errors.Is(err, ErrIdentityMismatch) || !strings.Contains(err.Error(), "MCP_CONFIGURATION_IDENTITY_MISMATCH") {
				t.Errorf("Read(%s) = %v, want MCP_CONFIGURATION_IDENTITY_MISMATCH", test.label, err)
			}
		})
	}
}

func TestReadRefusesAWholeMessageWithOneEntryThatDoesNotFit(t *testing.T) {
	key := aKey(t)
	other := aKey(t)
	for _, test := range []struct {
		label  string
		change func(fields map[string]any)
	}{
		{"another recipient key", func(fields map[string]any) { fields["publicKey"] = other.Public() }},
		{"a secret sealed to another key", func(fields map[string]any) {
			fields["secrets"] = []map[string]string{{"name": "graph-token", "sealed": sealedTo(t, other.Public(), "Bearer abc")}}
		}},
		{"a server whose URL holds a credential", func(fields map[string]any) {
			fields["servers"] = json.RawMessage(`[` + graph + `,{"name":"g","url":"https://token@g.example.test/mcp","tools":["t"]}]`)
		}},
		{"a field beyond the six", func(fields map[string]any) { fields["aip"] = map[string]string{"server": "https://aip.example.test"} }},
		{"no version", func(fields map[string]any) { delete(fields, "version") }},
		{"a negative version", func(fields map[string]any) { fields["version"] = -1 }},
		{"a version that is no whole number", func(fields map[string]any) { fields["version"] = 1.5 }},
		{"no servers", func(fields map[string]any) { delete(fields, "servers") }},
		{"no secrets", func(fields map[string]any) { delete(fields, "secrets") }},
		{"no fleet", func(fields map[string]any) { delete(fields, "fleetId") }},
		{"no plugin ship", func(fields map[string]any) { delete(fields, "pluginShipId") }},
	} {
		t.Run(test.label, func(t *testing.T) {
			if got, err := Read(aMessage(t, key, test.change), configured, key); err == nil {
				t.Errorf("Read(%s) = %+v, want a refusal", test.label, got)
			}
		})
	}
}

func TestReadRefusesPayloadsThatAreNoConfiguration(t *testing.T) {
	key := aKey(t)
	for _, payload := range []string{"company-graph", "null", "[]", `{}`} {
		if got, err := Read(payload, configured, key); err == nil {
			t.Errorf("Read(%q) = %+v, want a refusal", payload, got)
		}
	}
}

func TestReadNeverSaysASecretsValue(t *testing.T) {
	key := aKey(t)

	_, err := Read(aMessage(t, key, func(fields map[string]any) {
		fields["secrets"] = []map[string]string{{"name": "graph-token", "sealed": sealedTo(t, key.Public(), "Bearer s3cr3t\n")}}
	}), configured, key)

	if err == nil || strings.Contains(err.Error(), "s3cr3t") {
		t.Errorf("Read error = %v, want a refusal that does not say the value", err)
	}
}
