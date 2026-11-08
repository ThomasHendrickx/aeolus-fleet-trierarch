package aip

import (
	"os"
	"path/filepath"
	"testing"
)

const company = `{"server":"https://aip.example.test","tokenSecret":"aip-read"}`

func TestReadTakesTheServerAndTheNameOfItsTokensSecret(t *testing.T) {
	got, err := Read(company)

	want := Setting{Server: "https://aip.example.test", TokenSecret: "aip-read"}
	if err != nil || got != want {
		t.Errorf("Read(aip) = %+v, %v, want %+v", got, err, want)
	}
}

func TestReadRefuses(t *testing.T) {
	for _, test := range []struct{ label, payload string }{
		{"a payload that is no JSON", "aip"},
		{"a payload that is null", "null"},
		{"no server", `{"tokenSecret":"aip-read"}`},
		{"no tokenSecret", `{"server":"https://aip.example.test"}`},
		{"a server that is ftp", `{"server":"ftp://aip.example.test","tokenSecret":"aip-read"}`},
		{"a server that is a path", `{"server":"/srv/aip","tokenSecret":"aip-read"}`},
		{"a tokenSecret that is a path", `{"server":"https://aip.example.test","tokenSecret":"a/b"}`},
		{"a field that could hold the token", `{"server":"https://aip.example.test","tokenSecret":"aip-read","token":"abc"}`},
	} {
		if got, err := Read(test.payload); err == nil {
			t.Errorf("Read(%s) = %+v, want a refusal", test.label, got)
		}
	}
}

func TestFileHoldsNoneWhenMissing(t *testing.T) {
	file := &File{Path: filepath.Join(t.TempDir(), "aip.json")}

	file.Load()

	if got, ok := file.Current(); ok {
		t.Errorf("Current() = %+v, want none", got)
	}
}

func TestFileHoldsNoneWhenItDoesNotFit(t *testing.T) {
	file := &File{Path: filepath.Join(t.TempDir(), "aip.json")}
	if err := os.WriteFile(file.Path, []byte(`{"server":"ftp://aip.example.test","tokenSecret":"aip-read"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	file.Load()

	if got, ok := file.Current(); ok {
		t.Errorf("Current() = %+v, want none: a setting written by hand is read as strictly as one received", got)
	}
}

func TestFileKeepsTheAcceptedSettingAcrossLoads(t *testing.T) {
	file := &File{Path: filepath.Join(t.TempDir(), "state", "aip.json")}
	setting := Setting{Server: "https://aip.example.test", TokenSecret: "aip-read"}

	if err := file.Accept(&setting); err != nil {
		t.Fatal(err)
	}
	again := &File{Path: file.Path}
	again.Load()

	if got, ok := again.Current(); !ok || got != setting {
		t.Errorf("Current() after Load = %+v, %v, want %+v", got, ok, setting)
	}
}

func TestInListTakesTheAipTheMcpServersMessageCarries(t *testing.T) {
	got, err := InList(`{"servers":[],"aip":` + company + `}`)

	want := Setting{Server: "https://aip.example.test", TokenSecret: "aip-read"}
	if err != nil || got == nil || *got != want {
		t.Errorf("InList(list with aip) = %+v, %v, want %+v", got, err, want)
	}
}

func TestInListTakesNoneFromAnMcpServersMessageWithoutAip(t *testing.T) {
	if got, err := InList(`{"servers":[]}`); err != nil || got != nil {
		t.Errorf("InList(list without aip) = %+v, %v, want none", got, err)
	}
}

func TestInListRefusesAnAipThatDoesNotFit(t *testing.T) {
	for _, payload := range []string{`{"servers":[],"aip":null}`, `{"servers":[],"aip":{"server":"ftp://aip.example.test","tokenSecret":"aip-read"}}`, `{"servers":[],"aip":"https://aip.example.test"}`} {
		if got, err := InList(payload); err == nil {
			t.Errorf("InList(%s) = %+v, want a refusal", payload, got)
		}
	}
}

func TestFileHoldsNoneOnceAcceptedNone(t *testing.T) {
	file := &File{Path: filepath.Join(t.TempDir(), "aip.json")}
	if err := file.Accept(&Setting{Server: "https://aip.example.test", TokenSecret: "aip-read"}); err != nil {
		t.Fatal(err)
	}

	if err := file.Accept(nil); err != nil {
		t.Fatal(err)
	}
	again := &File{Path: file.Path}
	again.Load()

	if got, ok := again.Current(); ok {
		t.Errorf("Current() after Load = %+v, want none", got)
	}
}
