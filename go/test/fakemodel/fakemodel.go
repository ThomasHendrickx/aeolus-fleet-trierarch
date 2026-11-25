// Package fakemodel is a deterministic model server for the tests that run a real harness: it needs no account or key.
package fakemodel

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// Model is the model the server names in its answers.
const Model = "claude-sonnet-4-6"

// BashModel is a model server on the host's loopback that asks for the Bash command until it gets a tool result, then ends its turn.
func BashModel(t *testing.T, bash string) *httptest.Server {
	t.Helper()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/messages") {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"input_tokens":1}`)
			return
		}
		var request struct{ Messages []json.RawMessage }
		_ = json.NewDecoder(r.Body).Decode(&request)
		isAnswered := false
		for _, message := range request.Messages {
			isAnswered = isAnswered || strings.Contains(string(message), "tool_result")
		}
		block := map[string]any{"type": "text", "text": ""}
		delta := map[string]any{"type": "text_delta", "text": "Done."}
		stop := "end_turn"
		if !isAnswered {
			input, _ := json.Marshal(map[string]any{"command": bash, "description": "Run the requested action"})
			block = map[string]any{"type": "tool_use", "id": fmt.Sprintf("toolu_guard_%d", calls.Add(1)), "name": "Bash", "input": map[string]any{}}
			delta = map[string]any{"type": "input_json_delta", "partial_json": string(input)}
			stop = "tool_use"
		}
		w.Header().Set("Content-Type", "text/event-stream")
		events := []struct {
			name  string
			value any
		}{
			{"message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": "msg_guard", "type": "message", "role": "assistant", "content": []any{}, "model": Model, "stop_reason": nil, "usage": map[string]int{"input_tokens": 1, "output_tokens": 0}}}},
			{"content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": block}},
			{"content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": delta}},
			{"content_block_stop", map[string]any{"type": "content_block_stop", "index": 0}},
			{"message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": stop, "stop_sequence": nil}, "usage": map[string]int{"output_tokens": 1}}},
			{"message_stop", map[string]string{"type": "message_stop"}},
		}
		for _, event := range events {
			text, _ := json.Marshal(event.value)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.name, text)
		}
	}))
	t.Cleanup(server.Close)
	return server
}
