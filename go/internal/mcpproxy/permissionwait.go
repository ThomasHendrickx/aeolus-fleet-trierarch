package mcpproxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/permissions"
)

const permissionProgressInterval = 20 * time.Second

// PermissionCalls owns cancellation for calls in this proxy process. The key
// includes the session token so a new session cannot cancel its predecessor.
type PermissionCalls struct {
	mu    sync.Mutex
	calls map[string]context.CancelFunc
}

// NewPermissionCalls creates an empty registry for one proxy process.
func NewPermissionCalls() *PermissionCalls {
	return &PermissionCalls{calls: make(map[string]context.CancelFunc)}
}

func (c *PermissionCalls) count() int { c.mu.Lock(); defer c.mu.Unlock(); return len(c.calls) }
func (c *PermissionCalls) cancel(key string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if cancel := c.calls[key]; cancel != nil {
		cancel()
	}
}
func (c *PermissionCalls) add(key string, cancel context.CancelFunc) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.calls[key]; exists {
		return false
	}
	c.calls[key] = cancel
	return true
}
func (c *PermissionCalls) remove(key string) { c.mu.Lock(); defer c.mu.Unlock(); delete(c.calls, key) }

func permissionKey(ship, token string, id json.RawMessage) string {
	return ship + "/" + token + "/" + string(id)
}

func permissionTitle(arguments json.RawMessage) string {
	var input struct {
		Tool  string `json:"tool_name"`
		Input struct {
			Command string `json:"command"`
			Path    string `json:"file_path"`
		} `json:"input"`
	}
	if json.Unmarshal(arguments, &input) != nil {
		return "Permission"
	}
	if input.Tool == "Bash" && input.Input.Command != "" {
		return "Run `" + input.Input.Command + "`"
	}
	if input.Input.Path != "" {
		return "Edit `" + input.Input.Path + "`"
	}
	if input.Tool != "" {
		return input.Tool
	}
	return "Permission"
}

func streamMessage(w http.ResponseWriter, value any) error {
	text, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if _, err = fmt.Fprintf(w, "event: message\ndata: %s\n\n", text); err != nil {
		return err
	}
	return http.NewResponseController(w).Flush()
}

func (p Proxy) waitPermission(w http.ResponseWriter, r *http.Request, ship, token string, id, arguments, progressToken json.RawMessage) {
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	key := permissionKey(ship, token, id)
	if p.PermissionCalls == nil || !p.PermissionCalls.add(key, cancel) {
		writeJSON(w, http.StatusOK, errorAnswer(id, invalidRequest, "permission call already running or unavailable"))
		return
	}
	defer p.PermissionCalls.remove(key)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	if http.NewResponseController(w).Flush() != nil {
		return
	}
	result := make(chan permissions.Decision, 1)
	done := make(chan struct{})
	go func() { defer close(done); result <- p.PermissionWait(ctx, ship, token, permissionTitle(arguments)) }()
	// Cancellation propagates through the private channel before this call ends.
	defer func() { cancel(); <-done }()
	clock := p.PermissionClock
	if clock == nil {
		clock = permissions.SystemClock{}
	}
	timer := clock.NewTimer(permissionProgressInterval)
	defer func() { timer.Stop() }()
	progress := 0
	for {
		select {
		case <-ctx.Done():
			return
		case decision := <-result:
			if ctx.Err() != nil {
				return
			}
			text, _ := json.Marshal(decision)
			_ = streamMessage(w, map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"content": []any{map[string]string{"type": "text", "text": string(text)}}}})
			return
		case <-timer.Done():
			timer.Stop()
			progress++
			if len(progressToken) > 0 && string(progressToken) != "null" {
				if streamMessage(w, map[string]any{"jsonrpc": "2.0", "method": "notifications/progress", "params": map[string]any{"progressToken": progressToken, "progress": progress}}) != nil {
					return
				}
			}
			timer = clock.NewTimer(permissionProgressInterval)
		}
	}
}
