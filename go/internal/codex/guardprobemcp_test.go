package codex

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

func TestGuardProbeMCPAdvertisesAndRunsItsNoOpCheck(t *testing.T) {
	input := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
malformed line
{"jsonrpc":"2.0","id":"list","method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"check","arguments":{}}}`)
	var output bytes.Buffer
	if err := GuardProbeMCP(input, &output); err != nil {
		t.Fatal(err)
	}
	answers := json.NewDecoder(&output)
	for _, expected := range []string{
		`{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"guard_probe","version":"1"}}}`,
		`{"jsonrpc":"2.0","id":"list","result":{"tools":[{"name":"check","description":"No-op Codex guard diagnostic","inputSchema":{"type":"object","properties":{}}}]}}`,
		`{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"AEOLUS_GUARD_MCP_REACHED"}]}}`,
	} {
		var got, want map[string]any
		if err := answers.Decode(&got); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal([]byte(expected), &want); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("MCP response = %v, want %v", got, want)
		}
	}
	var extra json.RawMessage
	if err := answers.Decode(&extra); !errors.Is(err, io.EOF) {
		t.Fatalf("MCP response after the requests = %s, %v, want EOF", extra, err)
	}
}
