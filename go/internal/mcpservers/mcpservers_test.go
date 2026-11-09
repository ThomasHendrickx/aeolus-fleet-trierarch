package mcpservers

import (
	"slices"
	"strings"
	"testing"
)

const graph = `{"name":"company-graph","url":"https://graph.example.test/mcp","transport":"streamable-http","tools":["read_neo4j_cypher","get_neo4j_schema"]}`

func listOf(entries ...string) string {
	return `{"servers":[` + strings.Join(entries, ",") + `]}`
}

func TestReadTakesEachServerWithItsURLAndItsTools(t *testing.T) {
	got, err := Read(listOf(graph))

	want := []Server{{Name: "company-graph", URL: "https://graph.example.test/mcp", Transport: "streamable-http", Tools: []string{"read_neo4j_cypher", "get_neo4j_schema"}}}
	if err != nil || len(got) != 1 || got[0].Name != want[0].Name || got[0].URL != want[0].URL || got[0].Transport != want[0].Transport || !slices.Equal(got[0].Tools, want[0].Tools) {
		t.Errorf("Read(list) = %v, %v, want %v", got, err, want)
	}
}

func TestReadTakesAnEntryWithNoTransportAsStreamableHTTP(t *testing.T) {
	got, err := Read(listOf(`{"name":"g","url":"http://g.example.test/mcp","tools":["t"]}`))

	if err != nil || len(got) != 1 || got[0].Transport != "streamable-http" || got[0].URL != "http://g.example.test/mcp" {
		t.Errorf("Read(list) = %v, %v, want streamable-http and the http URL", got, err)
	}
}

func TestReadTakesNoneFromAnEmptyList(t *testing.T) {
	got, err := Read(`{"servers":[]}`)

	if err != nil || got == nil || len(got) != 0 {
		t.Errorf("Read(empty list) = %#v, %v, want an empty list and no error", got, err)
	}
}

func TestReadRefuses(t *testing.T) {
	for _, test := range []struct{ label, payload string }{
		{"a payload that is no JSON", "company-graph"},
		{"a payload without servers", "{}"},
		{"servers that are null", `{"servers":null}`},
		{"an entry that is null", `{"servers":[null]}`},
		{"a name that is a path", listOf(`{"name":"a/b","url":"https://g.example.test/mcp","transport":"streamable-http","tools":["t"]}`)},
		{"a name given twice", listOf(graph, graph)},
		{"a transport that is stdio", listOf(`{"name":"g","url":"https://g.example.test/mcp","transport":"stdio","tools":["t"]}`)},
		{"a URL that is ftp", listOf(`{"name":"g","url":"ftp://g.example.test/mcp","tools":["t"]}`)},
		{"a URL with a user", listOf(`{"name":"g","url":"https://token@g.example.test/mcp","transport":"streamable-http","tools":["t"]}`)},
		{"a URL with a query", listOf(`{"name":"g","url":"https://g.example.test/mcp?key=abc","transport":"streamable-http","tools":["t"]}`)},
		{"a URL that is a path", listOf(`{"name":"g","url":"/srv/mcp","transport":"streamable-http","tools":["t"]}`)},
		{"no tools", listOf(`{"name":"g","url":"https://g.example.test/mcp","transport":"streamable-http","tools":[]}`)},
		{"a tool that is no name", listOf(`{"name":"g","url":"https://g.example.test/mcp","transport":"streamable-http","tools":[""]}`)},
		{"a tool given twice", listOf(`{"name":"g","url":"https://g.example.test/mcp","transport":"streamable-http","tools":["t","t"]}`)},
		{"a field that could hold a credential", listOf(`{"name":"g","url":"https://g.example.test/mcp","transport":"streamable-http","tools":["t"],"token":"abc"}`)},
		{"a credential that holds a value", listOf(`{"name":"g","url":"https://g.example.test/mcp","tools":["t"],"credential":{"secret":"g-token","header":"Authorization","value":"Bearer abc"}}`)},
		{"a credential without a secret", listOf(`{"name":"g","url":"https://g.example.test/mcp","tools":["t"],"credential":{"header":"Authorization"}}`)},
		{"a credential whose secret is a path", listOf(`{"name":"g","url":"https://g.example.test/mcp","tools":["t"],"credential":{"secret":"a/b","header":"Authorization"}}`)},
		{"a credential without a header", listOf(`{"name":"g","url":"https://g.example.test/mcp","tools":["t"],"credential":{"secret":"g-token"}}`)},
		{"a credential header that is no header name", listOf(`{"name":"g","url":"https://g.example.test/mcp","tools":["t"],"credential":{"secret":"g-token","header":"X Key:"}}`)},
		{"a credential header that is Host", listOf(`{"name":"g","url":"https://g.example.test/mcp","tools":["t"],"credential":{"secret":"g-token","header":"host"}}`)},
		{"a credential header that is the MCP session's", listOf(`{"name":"g","url":"https://g.example.test/mcp","tools":["t"],"credential":{"secret":"g-token","header":"Mcp-Session-Id"}}`)},
		{"a credential header that is a proxy's", listOf(`{"name":"g","url":"https://g.example.test/mcp","tools":["t"],"credential":{"secret":"g-token","header":"Proxy-Authorization"}}`)},
		{"a credential that is null", listOf(`{"name":"g","url":"https://g.example.test/mcp","tools":["t"],"credential":null}`)},
	} {
		t.Run(test.label, func(t *testing.T) {
			if got, err := Read(test.payload); err == nil {
				t.Errorf("Read(%s) = %v, want a refusal", test.payload, got)
			}
		})
	}
}

func TestReadTakesTheCredentialAServerNames(t *testing.T) {
	got, err := Read(listOf(`{"name":"g","url":"https://g.example.test/mcp","tools":["t"],"credential":{"secret":"g-token","header":"X-Api-Key"}}`))

	if err != nil || len(got) != 1 || got[0].Credential == nil || *got[0].Credential != (Credential{Secret: "g-token", Header: "X-Api-Key"}) {
		t.Errorf("Read(list) = %+v, %v, want the credential g-token in X-Api-Key", got, err)
	}
}

func TestReadTakesAServerThatNamesNoCredential(t *testing.T) {
	got, err := Read(listOf(graph))

	if err != nil || len(got) != 1 || got[0].Credential != nil {
		t.Errorf("Read(list) = %+v, %v, want no credential", got, err)
	}
}

func TestWithCredentialHeldLeavesOutAServerWhoseSecretIsNotHeld(t *testing.T) {
	list, err := Read(listOf(graph,
		`{"name":"held","url":"https://h.example.test/mcp","tools":["t"],"credential":{"secret":"h-token","header":"Authorization"}}`,
		`{"name":"missing","url":"https://m.example.test/mcp","tools":["t"],"credential":{"secret":"m-token","header":"Authorization"}}`))
	if err != nil {
		t.Fatal(err)
	}

	got := WithCredentialHeld(list, []string{"h-token", "other"})

	var names []string
	for _, server := range got {
		names = append(names, server.Name)
	}
	if !slices.Equal(names, []string{"company-graph", "held"}) {
		t.Errorf("WithCredentialHeld = %v, want company-graph and held", names)
	}
}

func TestReadNamesTheServerItRefuses(t *testing.T) {
	_, err := Read(listOf(graph, `{"name":"other","url":"https://t@g.example.test/mcp","transport":"streamable-http","tools":["t"]}`))

	if err == nil || !strings.HasPrefix(err.Error(), "other: ") {
		t.Errorf("Read(list) error = %v, want it to name other", err)
	}
}

func TestOfferedByNamesEachServerOfTheListToEachHarnessThatCanAddIt(t *testing.T) {
	list, _ := Read(listOf(graph))

	got := OfferedBy(list, []string{"claude-code", "codex"}, map[string]func(string) bool{"claude-code": everyServer})

	if !slices.Equal(got["claude-code"], []string{"company-graph"}) || len(got["codex"]) != 0 {
		t.Errorf("OfferedBy = %v, want company-graph for claude-code only", got)
	}
}

func TestOfferedByOffersNothingWhenTheListIsEmpty(t *testing.T) {
	got := OfferedBy(nil, []string{"claude-code"}, map[string]func(string) bool{"claude-code": everyServer})

	if len(got["claude-code"]) != 0 {
		t.Errorf("OfferedBy = %v, want none", got)
	}
}

// everyServer is a harness that can add every server on the list.
func everyServer(string) bool { return true }

func TestOfferedByLeavesOutAServerAHarnessCannotAdd(t *testing.T) {
	list, _ := Read(listOf(graph, `{"name":"graph.v2","url":"https://graph.example.test/v2","tools":["read_neo4j_cypher"]}`))
	noDot := func(name string) bool { return !strings.Contains(name, ".") }

	got := OfferedBy(list, []string{"claude-code", "codex"}, map[string]func(string) bool{"claude-code": everyServer, "codex": noDot})

	if !slices.Equal(got["claude-code"], []string{"company-graph", "graph.v2"}) || !slices.Equal(got["codex"], []string{"company-graph"}) {
		t.Errorf("OfferedBy = %v, want both for claude-code and company-graph alone for codex", got)
	}
}
