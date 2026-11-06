package secrets

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"golang.org/x/crypto/nacl/box"
)

// aKey is a key made in a folder of its own.
func aKey(t *testing.T) Key {
	t.Helper()
	key, err := LoadOrMake(filepath.Join(t.TempDir(), "sealing-key"))
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

type entry struct {
	Name   string `json:"name"`
	Sealed string `json:"sealed"`
}

func messageOf(t *testing.T, public string, entries ...entry) string {
	t.Helper()
	if entries == nil {
		entries = []entry{}
	}
	text, err := json.Marshal(map[string]any{"publicKey": public, "secrets": entries})
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func TestLoadOrMakeMakesAKeyOnlyItsUserReads(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "sealing-key")

	key, err := LoadOrMake(path)

	info, statErr := os.Stat(path)
	if err != nil || statErr != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("LoadOrMake(%s) = %v, file %v, %v, want a file of mode 600", path, err, info, statErr)
	}
	if raw, err := base64.StdEncoding.DecodeString(key.Public()); err != nil || len(raw) != 32 {
		t.Errorf("Public() = %q, want 32 bytes of standard base64", key.Public())
	}
}

func TestLoadOrMakeKeepsTheKeyItMade(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sealing-key")
	first, err := LoadOrMake(path)
	if err != nil {
		t.Fatal(err)
	}

	again, err := LoadOrMake(path)

	if err != nil || again.Public() != first.Public() {
		t.Errorf("LoadOrMake again = %q, %v, want %q", again.Public(), err, first.Public())
	}
}

func TestLoadOrMakeRefusesAKeyFileThatDoesNotRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sealing-key")
	if err := os.WriteFile(path, []byte("not a key"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := LoadOrMake(path); err == nil {
		t.Error("LoadOrMake(a file that is no key) passed, want a refusal: a key is never made over one held")
	}
}

func TestLoadOrMakeMakesTheKeyOnlyItsUserReadsWhenTheFileWasLeftWider(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sealing-key")
	if _, err := LoadOrMake(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := LoadOrMake(path); err != nil {
		t.Fatal(err)
	}

	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("mode after LoadOrMake = %v, %v, want 600", info, err)
	}
}

func TestReadOpensEachSecretSealedToTheKey(t *testing.T) {
	key := aKey(t)

	got, err := Read(messageOf(t, key.Public(), entry{"graph-token", sealedTo(t, key.Public(), "Bearer abc")}, entry{"other", sealedTo(t, key.Public(), "x-1")}), key)

	want := map[string]string{"graph-token": "Bearer abc", "other": "x-1"}
	if err != nil || !maps.Equal(got, want) {
		t.Errorf("Read = %v, %v, want %v", got, err, want)
	}
}

func TestReadTakesAnEmptyList(t *testing.T) {
	key := aKey(t)

	got, err := Read(messageOf(t, key.Public()), key)

	if err != nil || got == nil || len(got) != 0 {
		t.Errorf("Read(empty) = %#v, %v, want no secrets and no error", got, err)
	}
}

func TestReadRefuses(t *testing.T) {
	key := aKey(t)
	other := aKey(t)
	sealed := func(value string) string { return sealedTo(t, key.Public(), value) }
	for _, test := range []struct{ label, payload string }{
		{"a payload that is no JSON", "graph-token"},
		{"a payload without secrets", `{"publicKey":"` + key.Public() + `"}`},
		{"secrets that are null", `{"publicKey":"` + key.Public() + `","secrets":null}`},
		{"secrets sealed to another key", messageOf(t, other.Public(), entry{"g", sealedTo(t, other.Public(), "v")})},
		{"a secret sealed to another key under this key's name", messageOf(t, key.Public(), entry{"g", sealedTo(t, other.Public(), "v")})},
		{"a sealed value that is no base64", messageOf(t, key.Public(), entry{"g", "!!"})},
		{"a name that is a path", messageOf(t, key.Public(), entry{"a/b", sealed("v")})},
		{"a name given twice", messageOf(t, key.Public(), entry{"g", sealed("v")}, entry{"g", sealed("w")})},
		{"an empty value", messageOf(t, key.Public(), entry{"g", sealed("")})},
		{"a value with a line break", messageOf(t, key.Public(), entry{"g", sealed("Bearer a\r\nHost: x")})},
		{"a value with a NUL", messageOf(t, key.Public(), entry{"g", sealed("a\x00b")})},
		{"a value that is no UTF-8", messageOf(t, key.Public(), entry{"g", sealed("\xff\xfe")})},
		{"a value over 8192 bytes", messageOf(t, key.Public(), entry{"g", sealed(strings.Repeat("a", 8193))})},
		{"an entry with a field beyond the two", `{"publicKey":"` + key.Public() + `","secrets":[{"name":"g","sealed":"` + sealed("v") + `","value":"v"}]}`},
	} {
		t.Run(test.label, func(t *testing.T) {
			if got, err := Read(test.payload, key); err == nil {
				t.Errorf("Read(%s) = %v, want a refusal", test.label, got)
			}
		})
	}
}

func TestReadTakesAValueOfExactly8192Bytes(t *testing.T) {
	key := aKey(t)
	value := strings.Repeat("a", 8192)

	got, err := Read(messageOf(t, key.Public(), entry{"g", sealedTo(t, key.Public(), value)}), key)

	if err != nil || got["g"] != value {
		t.Errorf("Read(8192 bytes) = %d bytes, %v, want it taken", len(got["g"]), err)
	}
}

func TestReadNeverSaysASecretsValue(t *testing.T) {
	key := aKey(t)

	_, err := Read(messageOf(t, key.Public(), entry{"g", sealedTo(t, key.Public(), "Bearer s3cr3t\n")}), key)

	if err == nil || strings.Contains(err.Error(), "s3cr3t") {
		t.Errorf("Read error = %v, want a refusal that does not say the value", err)
	}
}

func TestFileHoldsNoneWhenMissing(t *testing.T) {
	file := &File{Path: filepath.Join(t.TempDir(), "secrets.json")}

	file.Load()

	if got := file.Names(); len(got) != 0 {
		t.Errorf("Names() = %v, want none", got)
	}
}

func TestFileKeepsTheAcceptedSecretsOnlyItsUserReads(t *testing.T) {
	file := &File{Path: filepath.Join(t.TempDir(), "state", "secrets.json")}

	if err := file.Accept(map[string]string{"g": "Bearer abc"}); err != nil {
		t.Fatal(err)
	}
	again := &File{Path: file.Path}
	again.Load()

	if value, ok := again.Value("g"); !ok || value != "Bearer abc" {
		t.Errorf("Value(g) after Load = %q, %v, want Bearer abc", value, ok)
	}
	if info, err := os.Stat(file.Path); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, %v, want 600", info, err)
	}
	if _, err := os.Stat(file.Path + ".partial"); err == nil {
		t.Error("the partial file was left beside the secrets")
	}
}

func TestFileReplacesTheSecretsWhole(t *testing.T) {
	file := &File{Path: filepath.Join(t.TempDir(), "secrets.json")}
	if err := file.Accept(map[string]string{"g": "a", "h": "b"}); err != nil {
		t.Fatal(err)
	}

	if err := file.Accept(map[string]string{"h": "c"}); err != nil {
		t.Fatal(err)
	}

	if got := file.Names(); !slices.Equal(got, []string{"h"}) {
		t.Errorf("Names() = %v, want [h]", got)
	}
	if _, ok := file.Value("g"); ok {
		t.Error("Value(g) is held, want it gone with the list that dropped it")
	}
}

func TestFileHoldsNoneWhenItDoesNotFit(t *testing.T) {
	file := &File{Path: filepath.Join(t.TempDir(), "secrets.json")}
	if err := os.WriteFile(file.Path, []byte(`{"secrets":{"a/b":"v"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	file.Load()

	if got := file.Names(); len(got) != 0 {
		t.Errorf("Names() = %v, want none", got)
	}
}

func TestFileReadsTheSecretsAnotherProcessKeptSince(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secrets.json")
	reader := &File{Path: path}
	reader.Load()

	if err := (&File{Path: path}).Accept(map[string]string{"g": "v"}); err != nil {
		t.Fatal(err)
	}
	reader.Load()

	if value, ok := reader.Value("g"); !ok || value != "v" {
		t.Errorf("Value(g) = %q, %v, want v", value, ok)
	}
}

type anAsker struct {
	asked []string
	err   error
}

func (a *anAsker) AskForSecrets(pluginShipID string) error {
	a.asked = append(a.asked, pluginShipID)
	return a.err
}

func TestAskAsksTheTrierarchPluginsShipOnceAndNoMore(t *testing.T) {
	fleet := &anAsker{}
	ask := &Ask{Fleet: fleet, PluginShipID: "shp_x", Log: func(string) {}}

	ask.Once()
	ask.Once()

	if !slices.Equal(fleet.asked, []string{"shp_x"}) {
		t.Errorf("asked %v, want once", fleet.asked)
	}
}

func TestAskAsksAgainOnTheNextPassWhenTheFleetDoesNotTakeIt(t *testing.T) {
	fleet := &anAsker{err: os.ErrDeadlineExceeded}
	var logged []string
	ask := &Ask{Fleet: fleet, PluginShipID: "shp_x", Log: func(line string) { logged = append(logged, line) }}

	ask.Once()
	fleet.err = nil
	ask.Once()
	ask.Once()

	if len(fleet.asked) != 2 || len(logged) != 1 {
		t.Errorf("asked %v, logged %q, want two asks and one line", fleet.asked, logged)
	}
}

func TestAskAsksNothingWhenTheMachineDoesNotKnowTheShip(t *testing.T) {
	fleet := &anAsker{}

	(&Ask{Fleet: fleet, Log: func(string) {}}).Once()

	if len(fleet.asked) != 0 {
		t.Errorf("asked %v, want none", fleet.asked)
	}
}
