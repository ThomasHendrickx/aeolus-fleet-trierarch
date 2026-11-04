package keys

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

const key = "sk-ant-api03-test-key-not-real"

func aFolder(t *testing.T) Files {
	t.Helper()
	return Files{Folder: filepath.Join(t.TempDir(), "keys")}
}

func TestAKeyWrittenIsReadBackForItsHarnessAlone(t *testing.T) {
	files := aFolder(t)

	if err := files.Write("claude-code", key+"\n"); err != nil {
		t.Fatal(err)
	}

	if got, ok := files.Read("claude-code"); !ok || got != key {
		t.Fatalf("Read(claude-code) = %q, %v, want %q, true", got, ok, key)
	}
	if _, ok := files.Read("codex"); ok {
		t.Fatal("Read(codex) found a key, want none")
	}
}

func TestAKeyIsKeptReadableByItsUserOnlyInAFolderOnlyItsUserOpens(t *testing.T) {
	files := aFolder(t)

	if err := files.Write("claude-code", key); err != nil {
		t.Fatal(err)
	}

	for path, want := range map[string]os.FileMode{files.Folder: 0o700, filepath.Join(files.Folder, "claude-code"): 0o600} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != want {
			t.Fatalf("mode of %s = %v, %v, want %v", path, info.Mode().Perm(), err, want)
		}
	}
}

func TestAnEmptyKeyFileHoldsNoKey(t *testing.T) {
	files := aFolder(t)
	if err := files.Write("claude-code", "\n"); err != nil {
		t.Fatal(err)
	}

	if _, ok := files.Read("claude-code"); ok {
		t.Fatal("Read of an empty key file found a key, want none")
	}
}

func TestRemoveSaysWhetherThereWasAKeyToRemove(t *testing.T) {
	files := aFolder(t)
	if err := files.Write("claude-code", key); err != nil {
		t.Fatal(err)
	}

	first, err := files.Remove("claude-code")
	if err != nil || !first {
		t.Fatalf("first Remove = %v, %v, want true", first, err)
	}
	second, err := files.Remove("claude-code")
	if err != nil || second {
		t.Fatalf("second Remove = %v, %v, want false", second, err)
	}
	if files.Has("claude-code") {
		t.Fatal("Has after Remove = true, want false")
	}
}

func statesOf(t *testing.T) (Files, States) {
	t.Helper()
	files := aFolder(t)
	return files, States{Keys: files.Folder, File: filepath.Join(t.TempDir(), "proxy", "key-states.json")}
}

var monday = time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)

func TestNoKeyIsNoneAndAKeyNothingWasSaidOfIsReady(t *testing.T) {
	files, states := statesOf(t)

	if got := states.StateOf("claude-code"); got.State != None {
		t.Fatalf("StateOf with no key = %+v, want none", got)
	}
	if err := files.Write("claude-code", key); err != nil {
		t.Fatal(err)
	}
	if got := states.StateOf("claude-code"); got.State != Ready {
		t.Fatalf("StateOf a new key = %+v, want ready", got)
	}
}

func TestAKeyOutOfCreditStaysSoSinceItWasFirstSaidUntilASuccess(t *testing.T) {
	files, states := statesOf(t)
	if err := files.Write("claude-code", key); err != nil {
		t.Fatal(err)
	}

	if err := states.Record("claude-code", OutOfCredit, monday); err != nil {
		t.Fatal(err)
	}
	if err := states.Record("claude-code", OutOfCredit, monday.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if got := states.StateOf("claude-code"); got.State != OutOfCredit || got.At != "2026-11-02T09:00:00.000Z" {
		t.Fatalf("StateOf = %+v, want outOfCredit at 2026-11-02T09:00:00.000Z", got)
	}
	if err := states.Record("claude-code", Ready, monday.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if got := states.StateOf("claude-code"); got.State != Ready {
		t.Fatalf("StateOf after a success = %+v, want ready", got)
	}
}

func TestARefusedKeyStaysRefusedUntilANewKey(t *testing.T) {
	files, states := statesOf(t)
	if err := files.Write("claude-code", key); err != nil {
		t.Fatal(err)
	}
	if err := states.Record("claude-code", Refused, monday); err != nil {
		t.Fatal(err)
	}

	if err := states.Record("claude-code", Ready, monday.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if got := states.StateOf("claude-code"); got.State != Refused {
		t.Fatalf("StateOf after a success on a refused key = %+v, want refused", got)
	}
	// A new key is a new file: rename gives it an identity of its own.
	time.Sleep(10 * time.Millisecond)
	if err := files.Write("claude-code", "sk-ant-api03-another-key"); err != nil {
		t.Fatal(err)
	}
	if got := states.StateOf("claude-code"); got.State != Ready {
		t.Fatalf("StateOf a new key = %+v, want ready", got)
	}
}

func TestEachHarnessKeepsItsOwnState(t *testing.T) {
	files, states := statesOf(t)
	for _, harness := range []string{"claude-code", "codex"} {
		if err := files.Write(harness, key); err != nil {
			t.Fatal(err)
		}
	}

	if err := states.Record("codex", OutOfCredit, monday); err != nil {
		t.Fatal(err)
	}

	if got := states.StateOf("claude-code"); got.State != Ready {
		t.Fatalf("StateOf(claude-code) = %+v, want ready", got)
	}
	if got := states.StateOf("codex"); got.State != OutOfCredit {
		t.Fatalf("StateOf(codex) = %+v, want outOfCredit", got)
	}
}

func TestTheStatesAreReadInTheShapeTodaysProxyWritesThem(t *testing.T) {
	files, states := statesOf(t)
	if err := files.Write("claude-code", key); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(files.Folder, "claude-code"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(states.File), 0o700); err != nil {
		t.Fatal(err)
	}
	written := `{"claude-code":{"state":"refused","at":"2026-11-02T09:00:00.000Z","keyFile":{"ino":` + inodeOf(info) + `,"mtimeMs":` + millisecondsOf(info) + `}}}`
	if err := os.WriteFile(states.File, []byte(written), 0o600); err != nil {
		t.Fatal(err)
	}

	if got := states.StateOf("claude-code"); got.State != Refused || got.At != "2026-11-02T09:00:00.000Z" {
		t.Fatalf("StateOf = %+v, want refused at 2026-11-02T09:00:00.000Z", got)
	}
}

func TestWhatAVendorsAnswerSaysOfTheKey(t *testing.T) {
	cases := []struct {
		harness string
		status  int
		body    string
		want    State
	}{
		{"claude-code", 200, "", Ready},
		{"codex", 204, "", Ready},
		{"claude-code", 401, `{"type":"error","error":{"type":"authentication_error"}}`, Refused},
		{"codex", 401, "", Refused},
		{"claude-code", 402, "", OutOfCredit},
		{"claude-code", 400, `{"type":"error","error":{"type":"billing_error","message":"x"}}`, OutOfCredit},
		{"claude-code", 400, `{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}`, OutOfCredit},
		{"claude-code", 400, `{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits."}}`, OutOfCredit},
		{"claude-code", 429, `{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`, ""},
		{"claude-code", 529, `{"type":"error","error":{"type":"overloaded_error"}}`, ""},
		{"codex", 429, `{"error":{"type":"insufficient_quota","code":"insufficient_quota"}}`, OutOfCredit},
		{"codex", 429, `{"error":{"type":"requests","code":"credit_balance_exhausted"}}`, OutOfCredit},
		{"codex", 429, `{"error":{"type":"requests","code":"project_spend_limit_exceeded"}}`, OutOfCredit},
		{"codex", 429, `{"error":{"type":"requests","code":"rate_limit_exceeded"}}`, ""},
		{"codex", 500, "not json", ""},
	}
	for _, each := range cases {
		if got := StateOfAnswer(each.harness, each.status, each.body); got != each.want {
			t.Errorf("StateOfAnswer(%s, %d, %s) = %q, want %q", each.harness, each.status, each.body, got, each.want)
		}
	}
}
