package proxytoken

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

const scout = "shp_01m6jyczpnpp5c0vxh54c966cy"
const builder = "shp_01m6jyczpnpp5c0vxh54c966cz"

// aSession is the ship's session folder, with a hold pid of the pid given.
func aSession(t *testing.T, sessions string, shipID string, pid int) string {
	t.Helper()
	folder := filepath.Join(sessions, shipID)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "hold.pid"), []byte(strconv.Itoa(pid)), 0o600); err != nil {
		t.Fatal(err)
	}
	return folder
}

func TestEachStartGetsATokenOfItsOwn(t *testing.T) {
	first, second := New(), New()

	if first == second || len(first) < 40 {
		t.Fatalf("New() = %q then %q, want two different tokens of 32 random bytes", first, second)
	}
}

func TestATokenIsKeptInItsSessionsFolderReadableByItsUserOnly(t *testing.T) {
	folder := aSession(t, t.TempDir(), scout, os.Getpid())

	if err := Write(folder, Token{Harness: "claude-code", Token: "the-token"}); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(filepath.Join(folder, "proxy-token"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode of proxy-token = %v, %v, want 0600", info.Mode().Perm(), err)
	}
	if got, ok := Read(folder); !ok || got != (Token{Harness: "claude-code", Token: "the-token"}) {
		t.Fatalf("Read = %+v, %v, want the token written", got, ok)
	}
}

func TestATokenIsReadInTheShapeTodaysTrierarchWritesIt(t *testing.T) {
	folder := aSession(t, t.TempDir(), scout, os.Getpid())
	if err := os.WriteFile(filepath.Join(folder, "proxy-token"), []byte(`{"harness":"claude-code","token":"the-token"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if got, ok := Read(folder); !ok || got.Token != "the-token" {
		t.Fatalf("Read = %+v, %v, want the-token", got, ok)
	}
}

func TestTheTokenOfARunningSessionOfThatHarnessNamesItsShip(t *testing.T) {
	sessions := t.TempDir()
	if err := Write(aSession(t, sessions, scout, os.Getpid()), Token{Harness: "claude-code", Token: "scouts-token"}); err != nil {
		t.Fatal(err)
	}
	if err := Write(aSession(t, sessions, builder, os.Getpid()), Token{Harness: "claude-code", Token: "builders-token"}); err != nil {
		t.Fatal(err)
	}

	if got, ok := SessionOf(sessions, "claude-code", "builders-token"); !ok || got != builder {
		t.Fatalf("SessionOf(builders-token) = %q, %v, want %s", got, ok, builder)
	}
}

func TestATokenIsRefusedForAnotherHarnessAStoppedSessionOrAnotherToken(t *testing.T) {
	sessions := t.TempDir()
	if err := Write(aSession(t, sessions, scout, os.Getpid()), Token{Harness: "claude-code", Token: "scouts-token"}); err != nil {
		t.Fatal(err)
	}
	// No process runs as pid 0x3fffffff, above every pid Linux gives.
	if err := Write(aSession(t, sessions, builder, 0x3fffffff), Token{Harness: "claude-code", Token: "builders-token"}); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ harness, token string }{
		{"codex", "scouts-token"},
		{"claude-code", "builders-token"},
		{"claude-code", "scouts-token-not"},
		{"claude-code", ""},
	}
	for _, each := range cases {
		if got, ok := SessionOf(sessions, each.harness, each.token); ok {
			t.Errorf("SessionOf(%s, %q) = %q, want none", each.harness, each.token, got)
		}
	}
}

func TestNoSessionsFolderHoldsNoToken(t *testing.T) {
	if got, ok := SessionOf(filepath.Join(t.TempDir(), "none"), "claude-code", "a-token"); ok {
		t.Fatalf("SessionOf = %q, want none", got)
	}
}
