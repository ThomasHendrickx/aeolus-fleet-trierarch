package mask

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
)

func keep(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestEveryKnownCredentialIsMaskedAsWrittenAndJSONEscaped(t *testing.T) {
	at := paths.Of(t.TempDir(), "")
	keep(t, at.State, `{"entries":{"one":{"crewToken":"fake-crew-one"},"two":{"crewToken":"fake-crew-two"}}}`)
	for _, source := range []struct{ path, text string }{
		{at.CrewToken, "fake-trierarch-crew\n"}, {at.ModelToken, "fake-model-token\n"},
		{filepath.Join(at.Keys, "claude-code"), "fake-api-key\n"}, {at.SealingKey, "fake-sealing-key\n"},
		{at.McpConfiguration, `{"secrets":{"calendar":"fake-mcp-secret"}}`},
		{filepath.Join(at.Sessions, "other", "proxy-token"), `{"harness":"codex","token":"fake-model-proxy"}`},
		{filepath.Join(at.Sessions, "other", "mcp-access"), `{"token":"fake-mcp-access"}`},
		{filepath.Join(at.Sessions, "other", "mcp-config.json"), `{"mcpServers":{"calendar":{"headers":{"Authorization":"Bearer fake-mcp-token"}}}}`},
		{filepath.Join(at.Sessions, "other", "secret-env.json"), `{"FAKE_SECRET":"fake-quote\"slash\\tab\t<value>"}`},
	} {
		keep(t, source.path, source.text)
	}
	m, err := Load(at)
	if err != nil {
		t.Fatal(err)
	}
	for _, example := range []struct{ value, which string }{
		{"fake-crew-one", "crew token"}, {"fake-crew-two", "crew token"},
		{"fake-trierarch-crew", "trierarch crew token"}, {"fake-model-token", "model token"},
		{"fake-api-key", "claude-code API key"}, {"fake-sealing-key", "sealing key"},
		{"fake-mcp-secret", "MCP secret calendar"}, {"fake-model-proxy", "model proxy token"},
		{"fake-mcp-access", "MCP token"}, {"fake-mcp-token", "MCP token"},
		{"fake-quote\"slash\\tab\t<value>", "secret variable FAKE_SECRET"},
	} {
		t.Run(example.which+example.value[:4], func(t *testing.T) {
			encoded, _ := json.Marshal(example.value)
			for _, value := range []string{example.value, string(encoded[1 : len(encoded)-1])} {
				want := "before [masked: " + example.which + "] after"
				if got := m.Line("before " + value + " after"); got != want {
					t.Fatalf("masked line = %q, want %q", got, want)
				}
			}
		})
	}
	if got := m.Line("sk-unknown-credential-shaped-value"); got != "sk-unknown-credential-shaped-value" {
		t.Fatal("masked an unknown value by shape")
	}
}

func TestMaskingReplacesTheLongestValueBeforeItsPrefixWithoutRemaskingLabels(t *testing.T) {
	at := paths.Of(t.TempDir(), "")
	keep(t, at.State, `{"entries":{"one":{"crewToken":"fake-prefix"},"two":{"crewToken":"fake-prefix-long"}}}`)
	keep(t, at.ModelToken, "crew token")
	m, err := Load(at)
	if err != nil {
		t.Fatal(err)
	}
	if got := m.Line("fake-prefix-long fake-prefix crew token"); got != "[masked: crew token] [masked: crew token] [masked: model token]" {
		t.Fatalf("masked line = %q", got)
	}
}

type deniedFiles struct{ path string }

func (f deniedFiles) Open(path string) (fs.File, error) {
	if path == f.path {
		return nil, &fs.PathError{Op: "open", Path: path, Err: fs.ErrPermission}
	}
	return os.Open(path)
}

func TestUnreadableOrMalformedCredentialSourcesRefuseAllContent(t *testing.T) {
	for _, name := range []string{"state.json", "crew-token", "model-token", "keys", "keys/codex", "sealing-key", "mcp-configuration.json", "sessions", "sessions/other", "sessions/other/proxy-token", "sessions/other/mcp-access", "sessions/other/mcp-config.json", "sessions/other/secret-env.json"} {
		t.Run(name, func(t *testing.T) {
			at := paths.Of(t.TempDir(), "")
			keep(t, at.State, `{"entries":{}}`)
			keep(t, filepath.Join(at.Keys, "codex"), "fake-key")
			keep(t, filepath.Join(at.Sessions, "other", "secret-env.json"), `{}`)
			path := filepath.Join(at.Home, filepath.FromSlash(name))
			m, err := (Loader{Files: deniedFiles{path}}).Load(at)
			if err == nil || !strings.Contains(err.Error(), "cannot read "+path+" to mask it (permission denied)") {
				t.Fatalf("Load error = %v", err)
			}
			if got := m.Line("fake-should-never-appear"); got != "" {
				t.Fatalf("failed masker returned content: %q", got)
			}
		})
	}
	for _, malformed := range []string{`{"secrets":`, `{"secrets":{"name":12}}`} {
		at := paths.Of(t.TempDir(), "")
		keep(t, at.State, `{"entries":{}}`)
		keep(t, at.McpConfiguration, malformed)
		m, err := Load(at)
		if err == nil || m.Line("fake-value") != "" {
			t.Fatal("malformed credential source allowed content")
		}
	}
}

func TestOverlappingCredentialsNeverExposeEitherTail(t *testing.T) {
 at := paths.Of(t.TempDir(), "")
 keep(t, at.State, `{"entries":{"one":{"crewToken":"fake-abcdef"},"two":{"crewToken":"def-fake-tail"}}}`)
 m, err := Load(at)
 if err != nil { t.Fatal(err) }
 input := "before fake-abcdef-fake-tail after"
 want := "before [masked: crew token] after"
 if got := m.Line(input); got != want { t.Fatalf("Line(%q) = %q, want %q", input, got, want) }
}
