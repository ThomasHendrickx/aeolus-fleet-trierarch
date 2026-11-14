// Package mcpproxy is the MCP proxy (docs/design/crew-mcp-servers.md, decisions
// M6 and M7): a session reaches each crew-time MCP server it was started with
// at the trierarch's proxy on loopback, at a path of its ship and the server,
// with a token of its own. The proxy takes the token only from that ship's
// running session, and only for a server it was started with; it forwards
// only to the URL the trierarch plugin's list gives the server, never the
// session's token, and lists and forwards only the tools the list names,
// whatever the server offers. A call to any other tool is answered with a
// JSON-RPC error and never reaches the server, as is any resources/ or
// prompts/ request, which the list does not name, and the server's
// capabilities offer neither. For a server that needs a credential it sets
// the header the list names to the secret's value, over whatever the session
// sent in it, and refuses the server while it holds no such secret: the
// session never sees the value.
package mcpproxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpconfiguration"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpservers"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/permissions"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/proxytoken"
)

// Prefix is the proxy's paths: `<prefix><ship id>/<server>`.
const Prefix = "/mcp/"

// file is the session's access file in its folder, beside its hold's files.
const file = "mcp-access"

const (
	// requestRead is the most of a session's message the proxy reads: a JSON-RPC request is small.
	requestRead = 4 << 20
	// answerRead is the most of a server's JSON answer the proxy reads to filter it.
	answerRead = 64 << 20
	// invalidParams and invalidRequest are JSON-RPC's error codes.
	invalidParams  = -32602
	invalidRequest = -32600
)

var (
	shipIDPattern = regexp.MustCompile(`^shp_[0-7][0-9a-hjkmnp-tv-z]{25}$`)
	bearer        = regexp.MustCompile(`^Bearer (\S+)$`)
)

// Access is what a session may reach at the proxy: its token, fresh at each start, the names of the servers it was started with, and the fleet and plugin ship of the configuration it was started under, which it stays bound to across a restart of its hold or the trierarch.
type Access struct {
	Token        string   `json:"token"`
	Servers      []string `json:"servers"`
	FleetID      string   `json:"fleetId"`
	PluginShipID string   `json:"pluginShipId"`
}

// WriteAccess keeps the access in the session's folder, which only its user reads.
func WriteAccess(folder string, access Access) error {
	text, err := json.Marshal(access)
	if err != nil {
		return err
	}
	path := filepath.Join(folder, file)
	if err := os.WriteFile(path, text, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func readAccess(folder string) (Access, bool) {
	text, err := os.ReadFile(filepath.Join(folder, file))
	if err != nil {
		return Access{}, false
	}
	var access Access
	if json.Unmarshal(text, &access) != nil || access.Token == "" {
		return Access{}, false
	}
	return access, true
}

// PathOf is where the ship's session reaches the server at the proxy.
func PathOf(shipID string, server string) string { return Prefix + shipID + "/" + server }

// Proxy is the MCP proxy's handler.
type Proxy struct {
	// Sessions is the sessions folder, where each session keeps its access.
	Sessions string
	// PermissionWait serves cancellable permission waits through the private channel.
	PermissionWait  func(context.Context, string, string, string) permissions.Decision
	PermissionCalls *PermissionCalls
	PermissionClock permissions.Clock
	// Permissions hands a permission request to the trierarch over its private channel.
	Permissions func(context.Context, string, string) permissions.Decision
	// Configuration is the MCP configuration the trierarch applied last, read once at each request, so a changed URL, allowlist or credential takes effect on the next call; false when none is applied.
	Configuration func() (mcpconfiguration.Configuration, bool)
}

// credentialOf is the header and value the server's credential sets; false when it needs one the configuration does not hold.
func credentialOf(server mcpservers.Server, held map[string]string) (header string, value string, ok bool) {
	if server.Credential == nil {
		return "", "", true
	}
	value, ok = held[server.Credential.Secret]
	return server.Credential.Header, value, ok
}

func refuse(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": "aeolus MCP proxy: " + message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	text, _ := json.Marshal(value)
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(text)
}

// accessOf is the access of the ship's running session, started with the server, whose token it is; false when there is none.
func (p Proxy) accessOf(shipID string, server string, token string) (Access, bool) {
	if token == "" {
		return Access{}, false
	}
	folder := filepath.Join(p.Sessions, shipID)
	access, ok := readAccess(folder)
	if !ok || subtle.ConstantTimeCompare([]byte(token), []byte(access.Token)) != 1 || !slices.Contains(access.Servers, server) || !proxytoken.IsHoldRunning(folder) {
		return Access{}, false
	}
	return access, true
}

// applied is the configuration applied now; false when none is.
func (p Proxy) applied() (mcpconfiguration.Configuration, bool) {
	if p.Configuration == nil {
		return mcpconfiguration.Configuration{}, false
	}
	return p.Configuration()
}

func serverOf(configuration mcpconfiguration.Configuration, name string) (mcpservers.Server, bool) {
	for _, server := range configuration.Servers {
		if server.Name == name {
			return server, true
		}
	}
	return mcpservers.Server{}, false
}

func (p Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rest, _ := strings.CutPrefix(r.URL.EscapedPath(), Prefix)
	shipID, name, ok := strings.Cut(rest, "/")
	if !ok || !shipIDPattern.MatchString(shipID) || name == "" || strings.Contains(name, "/") {
		refuse(w, http.StatusNotFound, "it answers only at a ship's MCP server")
		return
	}
	token := ""
	if match := bearer.FindStringSubmatch(r.Header.Get("authorization")); match != nil {
		token = match[1]
	}
	access, ok := p.accessOf(shipID, name, token)
	if !ok {
		refuse(w, http.StatusUnauthorized, "not the token of a running session of this ship started with "+name)
		return
	}
	if name == permissions.Server {
		p.permission(w, r, shipID, token)
		return
	}
	// A session stays bound to the fleet and plugin ship it started under: a configuration of another, even one naming a server of the same name, never serves it.
	configuration, isApplied := p.applied()
	if !isApplied || configuration.Identity != (mcpconfiguration.Identity{FleetID: access.FleetID, PluginShipID: access.PluginShipID}) {
		refuse(w, http.StatusForbidden, mcpconfiguration.IdentityMismatch+": this session started under another MCP configuration than the one applied")
		return
	}
	server, ok := serverOf(configuration, name)
	if !ok {
		refuse(w, http.StatusNotFound, name+" is not on the MCP servers this trierarch holds")
		return
	}
	// The server's URL is fixed, as the list gives it: the session's path and query never reach it, so it forwards to no other.
	target, err := url.Parse(server.URL)
	if err != nil {
		refuse(w, http.StatusNotFound, name+" is not on the MCP servers this trierarch holds")
		return
	}
	header, credential, ok := credentialOf(server, configuration.Secrets)
	if !ok {
		refuse(w, http.StatusServiceUnavailable, name+"'s credential is not held by this trierarch")
		return
	}
	if r.Method == http.MethodPost {
		body, err := io.ReadAll(io.LimitReader(r.Body, requestRead+1))
		if err != nil || len(body) > requestRead {
			refuse(w, http.StatusRequestEntityTooLarge, "a message is at most 4 MB")
			return
		}
		if refusal, ok := refusalOf(body, server.Tools); ok {
			writeJSON(w, http.StatusOK, refusal)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
	}
	forward := &httputil.ReverseProxy{
		Rewrite: func(out *httputil.ProxyRequest) {
			out.Out.URL = target
			out.Out.Host = ""
			out.Out.Header.Del("authorization")
			out.Out.Header.Del("cookie")
			// The answer is read to filter its tools: it comes uncompressed.
			out.Out.Header.Del("accept-encoding")
			if header != "" {
				out.Out.Header.Set(header, credential)
			}
		},
		// A stream goes on as the server writes it.
		FlushInterval: -1,
		ModifyResponse: func(answer *http.Response) error {
			return filterAnswer(answer, server.Tools)
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			refuse(w, http.StatusBadGateway, name+" could not be reached")
		},
	}
	forward.ServeHTTP(w, r)
}

// decode reads JSON as it is, numbers as written and keys exactly, as the server reads them.
func decode(text []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(text))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if decoder.More() {
		return nil, errors.New("more than one JSON value")
	}
	return value, nil
}

func encode(value any) []byte {
	var text bytes.Buffer
	encoder := json.NewEncoder(&text)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return bytes.TrimSuffix(text.Bytes(), []byte("\n"))
}

// forbiddenTool is the tool a message calls that the list does not name, empty when it calls none.
func forbiddenTool(message any, tools []string) string {
	fields, ok := message.(map[string]any)
	if !ok || fields["method"] != "tools/call" {
		return ""
	}
	params, _ := fields["params"].(map[string]any)
	name, _ := params["name"].(string)
	if slices.Contains(tools, name) {
		return ""
	}
	if name == "" {
		return "a tool without a name"
	}
	return name
}

// forbiddenMethod is the resources/ or prompts/ method a message requests, which a definition does not name; empty when it requests none.
func forbiddenMethod(message any) string {
	fields, _ := message.(map[string]any)
	method, _ := fields["method"].(string)
	if strings.HasPrefix(method, "resources/") || strings.HasPrefix(method, "prompts/") {
		return method
	}
	return ""
}

func errorAnswer(id any, code int, message string) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": "aeolus MCP proxy: " + message}}
}

// refusalOf is the answer to a session's message that the proxy does not forward: one it cannot read, or a call to a tool the list does not name, alone or in a batch.
func refusalOf(body []byte, tools []string) (map[string]any, bool) {
	value, err := decode(body)
	if err != nil {
		return errorAnswer(nil, invalidRequest, "a message is one JSON-RPC message or a batch of them"), true
	}
	if batch, ok := value.([]any); ok {
		for _, message := range batch {
			if tool := forbiddenTool(message, tools); tool != "" {
				return errorAnswer(nil, invalidParams, "the batch calls "+tool+", which is not a tool a session may call"), true
			}
			if method := forbiddenMethod(message); method != "" {
				return errorAnswer(nil, invalidRequest, "the batch requests "+method+", which a session may not"), true
			}
		}
		return nil, false
	}
	fields, _ := value.(map[string]any)
	if tool := forbiddenTool(value, tools); tool != "" {
		return errorAnswer(fields["id"], invalidParams, tool+" is not a tool a session may call"), true
	}
	if method := forbiddenMethod(value); method != "" {
		return errorAnswer(fields["id"], invalidRequest, method+" is not a request a session may make"), true
	}
	return nil, false
}

// withoutResourcesAndPrompts takes the resources and prompts out of an initialize answer's capabilities; false when it holds neither.
func withoutResourcesAndPrompts(message any) bool {
	fields, ok := message.(map[string]any)
	if !ok {
		return false
	}
	result, _ := fields["result"].(map[string]any)
	capabilities, _ := result["capabilities"].(map[string]any)
	_, hasResources := capabilities["resources"]
	_, hasPrompts := capabilities["prompts"]
	delete(capabilities, "resources")
	delete(capabilities, "prompts")
	return hasResources || hasPrompts
}

// withListedTools leaves in a message's tools list only the tools the list names; false when it holds none.
func withListedTools(message any, tools []string) bool {
	fields, ok := message.(map[string]any)
	if !ok {
		return false
	}
	result, _ := fields["result"].(map[string]any)
	listed, ok := result["tools"].([]any)
	if !ok {
		return false
	}
	kept := []any{}
	for _, tool := range listed {
		described, _ := tool.(map[string]any)
		if name, _ := described["name"].(string); slices.Contains(tools, name) {
			kept = append(kept, tool)
		}
	}
	result["tools"] = kept
	return true
}

// filtered is the server's JSON with every tools list holding only the tools the list names and no resources or prompts capability, alone or in a batch; unchanged when it lists none.
func filtered(text []byte, tools []string) []byte {
	value, err := decode(text)
	if err != nil {
		return text
	}
	isChanged := false
	if batch, ok := value.([]any); ok {
		for _, message := range batch {
			isChanged = withListedTools(message, tools) || isChanged
			isChanged = withoutResourcesAndPrompts(message) || isChanged
		}
	} else {
		isChanged = withListedTools(value, tools)
		isChanged = withoutResourcesAndPrompts(value) || isChanged
	}
	if !isChanged {
		return text
	}
	return encode(value)
}

// filterAnswer filters the server's answer as it goes to the session: JSON whole, an event stream event by event.
func filterAnswer(answer *http.Response, tools []string) error {
	kind, _, _ := mime.ParseMediaType(answer.Header.Get("content-type"))
	switch kind {
	case "application/json":
		text, err := io.ReadAll(io.LimitReader(answer.Body, answerRead+1))
		_ = answer.Body.Close()
		if err != nil {
			return err
		}
		if len(text) > answerRead {
			return errors.New("the answer is over 64 MB")
		}
		text = filtered(text, tools)
		answer.Body = io.NopCloser(bytes.NewReader(text))
		answer.ContentLength = int64(len(text))
		answer.Header.Del("content-length")
	case "text/event-stream":
		answer.Body = filteredStream(answer.Body, tools)
		answer.ContentLength = -1
		answer.Header.Del("content-length")
	}
	return nil
}

// stream is a filtered event stream: closing it closes the server's.
type stream struct {
	*io.PipeReader
	upstream io.Closer
}

func (s stream) Close() error {
	_ = s.PipeReader.Close()
	return s.upstream.Close()
}

// filteredStream is the server's event stream with each event's data filtered as JSON is; its goroutine ends when the server's stream ends or the session's is closed.
func filteredStream(upstream io.ReadCloser, tools []string) io.ReadCloser {
	reader, writer := io.Pipe()
	go func() {
		defer upstream.Close()
		lines := bufio.NewReader(upstream)
		var event []string
		for {
			line, err := lines.ReadString('\n')
			if line != "" {
				text := strings.TrimRight(line, "\r\n")
				if text != "" {
					event = append(event, text)
				} else if _, werr := writer.Write(eventOf(event, tools)); werr != nil {
					return
				} else {
					event = nil
				}
			}
			if err != nil {
				// An event the stream cut off goes on as it came.
				if len(event) > 0 {
					_, _ = writer.Write([]byte(strings.Join(event, "\n") + "\n"))
				}
				if errors.Is(err, io.EOF) {
					_ = writer.Close()
				} else {
					_ = writer.CloseWithError(err)
				}
				return
			}
		}
	}()
	return stream{PipeReader: reader, upstream: upstream}
}

// eventOf is one event's lines with its data filtered, ended by its blank line; its other fields as they came.
func eventOf(lines []string, tools []string) []byte {
	var data []string
	var others []string
	for _, line := range lines {
		if rest, ok := strings.CutPrefix(line, "data:"); ok {
			data = append(data, strings.TrimPrefix(rest, " "))
		} else {
			others = append(others, line)
		}
	}
	var out strings.Builder
	for _, line := range others {
		out.WriteString(line + "\n")
	}
	if data != nil {
		joined := []byte(strings.Join(data, "\n"))
		if text := filtered(joined, tools); !bytes.Equal(text, joined) {
			out.WriteString("data: " + string(text) + "\n")
		} else {
			for _, line := range data {
				out.WriteString("data: " + line + "\n")
			}
		}
	}
	out.WriteString("\n")
	return []byte(out.String())
}

// AuthorizesPermission binds a private channel call to the ship's running session.
func AuthorizesPermission(sessions, ship, token string) bool {
	if !shipIDPattern.MatchString(ship) {
		return false
	}
	_, ok := (Proxy{Sessions: sessions}).accessOf(ship, permissions.Server, token)
	return ok
}

func (p Proxy) permission(w http.ResponseWriter, r *http.Request, ship, token string) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var message struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			Name            string          `json:"name"`
			ProtocolVersion string          `json:"protocolVersion"`
			Arguments       json.RawMessage `json:"arguments"`
			RequestID       json.RawMessage `json:"requestId"`
			Meta            struct {
				ProgressToken json.RawMessage `json:"progressToken"`
			} `json:"_meta"`
		} `json:"params"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, requestRead)).Decode(&message) != nil {
		writeJSON(w, http.StatusOK, errorAnswer(nil, invalidRequest, "invalid permission request"))
		return
	}
	if message.Method == "notifications/cancelled" {
		p.PermissionCalls.cancel(permissionKey(ship, token, message.Params.RequestID))
	}
	if len(message.ID) == 0 {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	var result any
	switch message.Method {
	case "initialize":
		result = map[string]any{"protocolVersion": message.Params.ProtocolVersion, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]string{"name": permissions.Server, "version": "1"}}
	case "tools/list":
		result = map[string]any{"tools": []any{map[string]any{"name": "ask", "description": "Ask the ship's owner for permission", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"tool_name": map[string]string{"type": "string"}, "input": map[string]string{"type": "object"}, "tool_use_id": map[string]string{"type": "string"}}, "required": []string{"tool_name", "input", "tool_use_id"}}}}}
	case "tools/call":
		if message.Params.Name != "ask" {
			writeJSON(w, http.StatusOK, errorAnswer(message.ID, invalidParams, "unknown permission tool"))
			return
		}
		if p.PermissionWait != nil {
			p.waitPermission(w, r, ship, token, message.ID, message.Params.Arguments, message.Params.Meta.ProgressToken)
			return
		}
		decision := permissions.Decision{Behavior: "deny", Message: "could not read this ship's owner: nobody is asked"}
		if p.Permissions != nil {
			decision = p.Permissions(r.Context(), ship, token)
		}
		text, _ := json.Marshal(decision)
		result = map[string]any{"content": []any{map[string]string{"type": "text", "text": string(text)}}}
	case "ping":
		result = map[string]any{}
	default:
		writeJSON(w, http.StatusOK, errorAnswer(message.ID, -32601, "unknown permission method"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"jsonrpc": "2.0", "id": message.ID, "result": result})
}
