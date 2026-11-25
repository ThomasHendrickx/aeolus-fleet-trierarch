package codex

import (
	"bufio"
	"encoding/json"
	"io"
)

// GuardProbeMCP serves a local no-op tool used by the guard diagnostic.
func GuardProbeMCP(input io.Reader, output io.Writer) error {
	encoder := json.NewEncoder(output)
	lines := bufio.NewScanner(input)
	for lines.Scan() {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				ProtocolVersion string `json:"protocolVersion"`
			} `json:"params"`
		}
		if json.Unmarshal(lines.Bytes(), &request) != nil || len(request.ID) == 0 {
			continue
		}
		var result any
		switch request.Method {
		case "initialize":
			result = map[string]any{
				"protocolVersion": request.Params.ProtocolVersion,
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo":      map[string]string{"name": "guard_probe", "version": "1"},
			}
		case "tools/list":
			result = json.RawMessage(`{"tools":[{"name":"check","description":"No-op Codex guard diagnostic","inputSchema":{"type":"object","properties":{}}}]}`)
		case "tools/call":
			result = json.RawMessage(`{"content":[{"type":"text","text":"AEOLUS_GUARD_MCP_REACHED"}]}`)
		default:
			result = map[string]any{}
		}
		answer := map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result}
		if err := encoder.Encode(answer); err != nil {
			return err
		}
	}
	return lines.Err()
}
