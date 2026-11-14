package mcpproxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpconfiguration"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpservers"
)

const (
	fleet   = "flt_01m3tb1zgr5h2ffee12xnch8sv"
	plugin  = "shp_01m3tb1zhjs6kthtcs2zvksacv"
	scout   = "shp_01m6jyczpnpp5c0vxh54c966cy"
	builder = "shp_01m6jyczpnpp5c0vxh54c966cz"
	// stoppedPID is no running process: the pid file of a session that stopped.
	stoppedPID = 999999999
)

// fakeGraph is a fake company graph: a Streamable HTTP MCP server with a read tool, a schema tool and a write tool, answering in JSON or as an event stream.
type fakeGraph struct {
	isStream bool

	mu       sync.Mutex
	called   []string
	headers  []http.Header
	paths    []string
	requests int
}

func (g *fakeGraph) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	g.requests++
	g.headers = append(g.headers, r.Header.Clone())
	g.paths = append(g.paths, r.URL.RequestURI())
	g.mu.Unlock()
	var message struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	_ = json.NewDecoder(r.Body).Decode(&message)
	var result any
	switch message.Method {
	case "tools/list":
		result = map[string]any{"tools": []map[string]any{
			{"name": "read_neo4j_cypher", "inputSchema": map[string]any{"type": "object"}},
			{"name": "write_neo4j_cypher", "inputSchema": map[string]any{"type": "object"}},
			{"name": "get_neo4j_schema", "inputSchema": map[string]any{"type": "object"}},
		}}
	case "tools/call":
		g.mu.Lock()
		g.called = append(g.called, message.Params.Name)
		g.mu.Unlock()
		result = map[string]any{"content": []map[string]any{{"type": "text", "text": "answered by " + message.Params.Name}}}
	case "initialize":
		result = map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{"tools": map[string]any{}, "resources": map[string]any{}, "prompts": map[string]any{}}}
	default:
		result = map[string]any{}
	}
	answer, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": message.ID, "result": result})
	w.Header().Set("mcp-session-id", "graph-session")
	if g.isStream {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, "event: message\nid: 1\ndata: "+string(answer)+"\n\n")
		return
	}
	w.Header().Set("content-type", "application/json")
	_, _ = w.Write(answer)
}

func (g *fakeGraph) calls() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.called)
}

// aSession is the ship's session folder, with its hold's pid and the MCP servers it was started with.
func aSession(t *testing.T, sessions string, shipID string, pid int, access Access) {
	t.Helper()
	folder := filepath.Join(sessions, shipID)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "hold.pid"), []byte(strconv.Itoa(pid)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteAccess(folder, access); err != nil {
		t.Fatal(err)
	}
}

// applied is the configuration the trierarch applied, of this fleet and plugin ship, read at each call.
func applied(list []mcpservers.Server, held map[string]string) func() (mcpconfiguration.Configuration, bool) {
	return appliedAs(mcpconfiguration.Identity{FleetID: fleet, PluginShipID: plugin}, list, held)
}

func appliedAs(identity mcpconfiguration.Identity, list []mcpservers.Server, held map[string]string) func() (mcpconfiguration.Configuration, bool) {
	return func() (mcpconfiguration.Configuration, bool) {
		return mcpconfiguration.Configuration{Identity: identity, Version: 1, PublicKey: "key-a", Servers: list, Secrets: held}, true
	}
}

// aProxy is the MCP proxy in front of the graph, listed as company-graph with its two read tools, and a running scout session started with it.
func aProxy(t *testing.T, graph *fakeGraph) *httptest.Server {
	t.Helper()
	upstream := httptest.NewServer(graph)
	t.Cleanup(upstream.Close)
	sessions := t.TempDir()
	aSession(t, sessions, scout, os.Getpid(), Access{Token: "scouts-token", Servers: []string{"company-graph"}, FleetID: fleet, PluginShipID: plugin})
	aSession(t, sessions, builder, os.Getpid(), Access{Token: "builders-token", Servers: []string{}, FleetID: fleet, PluginShipID: plugin})
	list := []mcpservers.Server{{Name: "company-graph", URL: upstream.URL + "/mcp", Transport: mcpservers.Transport, Tools: []string{"read_neo4j_cypher", "get_neo4j_schema"}}}
	proxy := httptest.NewServer(Proxy{Sessions: sessions, Configuration: applied(list, nil)})
	t.Cleanup(proxy.Close)
	return proxy
}

func call(t *testing.T, proxy *httptest.Server, path string, token string, body string) (int, string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, proxy.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("accept", "application/json, text/event-stream")
	request.Header.Set("authorization", "Bearer "+token)
	answer, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer answer.Body.Close()
	text, _ := io.ReadAll(answer.Body)
	return answer.StatusCode, string(text)
}

const listTools = `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`

func callTool(name string) string {
	return `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"` + name + `","arguments":{"query":"MATCH (n) RETURN n"}}}`
}

// toolsIn are the tool names of a tools/list answer, read from JSON or from an event stream's data.
func toolsIn(t *testing.T, text string) []string {
	t.Helper()
	data := text
	if strings.Contains(text, "data: ") {
		lines := bufio.NewScanner(strings.NewReader(text))
		data = ""
		for lines.Scan() {
			if rest, ok := strings.CutPrefix(lines.Text(), "data: "); ok {
				data += rest
			}
		}
	}
	var answer struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(data), &answer); err != nil {
		t.Fatalf("the answer %q is no JSON-RPC answer: %v", text, err)
	}
	names := []string{}
	for _, tool := range answer.Result.Tools {
		names = append(names, tool.Name)
	}
	return names
}

func TestTheProxyListsOnlyTheToolsTheDefinitionNames(t *testing.T) {
	for _, isStream := range []bool{false, true} {
		t.Run("stream "+strconv.FormatBool(isStream), func(t *testing.T) {
			proxy := aProxy(t, &fakeGraph{isStream: isStream})
			status, text := call(t, proxy, "/mcp/"+scout+"/company-graph", "scouts-token", listTools)
			if status != http.StatusOK {
				t.Fatalf("tools/list = %d %s, want 200", status, text)
			}
			if got, want := toolsIn(t, text), []string{"read_neo4j_cypher", "get_neo4j_schema"}; !slices.Equal(got, want) {
				t.Errorf("tools/list = %v, want %v", got, want)
			}
		})
	}
}

func TestTheProxyForwardsACallToAListedTool(t *testing.T) {
	graph := &fakeGraph{}
	proxy := aProxy(t, graph)
	status, text := call(t, proxy, "/mcp/"+scout+"/company-graph", "scouts-token", callTool("read_neo4j_cypher"))
	if status != http.StatusOK || !strings.Contains(text, "answered by read_neo4j_cypher") {
		t.Errorf("a call to read_neo4j_cypher = %d %s, want the graph's answer", status, text)
	}
	if got := graph.calls(); !slices.Equal(got, []string{"read_neo4j_cypher"}) {
		t.Errorf("the graph was called with %v, want [read_neo4j_cypher]", got)
	}
}

func TestTheProxyRefusesACallToAToolTheDefinitionDoesNotNameAndNeverForwardsIt(t *testing.T) {
	for _, body := range []string{callTool("write_neo4j_cypher"), "[" + callTool("read_neo4j_cypher") + "," + callTool("write_neo4j_cypher") + "]"} {
		graph := &fakeGraph{}
		proxy := aProxy(t, graph)
		_, text := call(t, proxy, "/mcp/"+scout+"/company-graph", "scouts-token", body)
		var answer struct {
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(text), &answer) != nil || answer.Error == nil || !strings.Contains(answer.Error.Message, "write_neo4j_cypher") {
			t.Errorf("a call of %s = %s, want a JSON-RPC error naming write_neo4j_cypher", body, text)
		}
		if graph.requests != 0 {
			t.Errorf("the graph got %d requests for %s, want none", graph.requests, body)
		}
	}
}

func TestTheProxyRefusesATokenThatIsNotOfARunningSessionStartedWithTheServer(t *testing.T) {
	graph := &fakeGraph{}
	upstream := httptest.NewServer(graph)
	defer upstream.Close()
	sessions := t.TempDir()
	aSession(t, sessions, scout, os.Getpid(), Access{Token: "scouts-token", Servers: []string{"company-graph"}, FleetID: fleet, PluginShipID: plugin})
	aSession(t, sessions, builder, os.Getpid(), Access{Token: "builders-token", Servers: []string{}, FleetID: fleet, PluginShipID: plugin})
	const stopped = "shp_01m6jyczpnpp5c0vxh54c966d0"
	aSession(t, sessions, stopped, stoppedPID, Access{Token: "stopped-token", Servers: []string{"company-graph"}, FleetID: fleet, PluginShipID: plugin})
	list := []mcpservers.Server{{Name: "company-graph", URL: upstream.URL, Transport: mcpservers.Transport, Tools: []string{"read_neo4j_cypher"}}}
	proxy := httptest.NewServer(Proxy{Sessions: sessions, Configuration: applied(list, nil)})
	defer proxy.Close()
	cases := []struct {
		name  string
		path  string
		token string
	}{
		{"a stopped session's token", "/mcp/" + stopped + "/company-graph", "stopped-token"},
		{"another ship's token", "/mcp/" + scout + "/company-graph", "builders-token"},
		{"a ship's token at another ship's path", "/mcp/" + builder + "/company-graph", "scouts-token"},
		{"the token of a session not started with the server", "/mcp/" + builder + "/company-graph", "builders-token"},
		{"no token", "/mcp/" + scout + "/company-graph", ""},
	}
	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			if status, text := call(t, proxy, each.path, each.token, listTools); status != http.StatusUnauthorized {
				t.Errorf("tools/list at %s = %d %s, want 401", each.path, status, text)
			}
		})
	}
	if graph.requests != 0 {
		t.Errorf("the graph got %d requests, want none", graph.requests)
	}
}

func TestTheProxyForwardsOnlyToTheServersURLWithoutTheSessionsToken(t *testing.T) {
	graph := &fakeGraph{}
	proxy := aProxy(t, graph)
	request, _ := http.NewRequest(http.MethodPost, proxy.URL+"/mcp/"+scout+"/company-graph?to=elsewhere", bytes.NewReader([]byte(listTools)))
	request.Header.Set("authorization", "Bearer scouts-token")
	request.Header.Set("mcp-session-id", "graph-session")
	answer, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = answer.Body.Close()
	if got := graph.paths; !slices.Equal(got, []string{"/mcp"}) {
		t.Errorf("the graph was asked at %v, want only its own URL's /mcp", got)
	}
	if got := graph.headers[0].Get("authorization"); got != "" {
		t.Errorf("the graph got authorization %q, want none", got)
	}
	if got := graph.headers[0].Get("mcp-session-id"); got != "graph-session" {
		t.Errorf("the graph got mcp-session-id %q, want graph-session", got)
	}
	if got := answer.Header.Get("mcp-session-id"); got != "graph-session" {
		t.Errorf("the session got mcp-session-id %q, want graph-session", got)
	}
}

func TestTheProxyRefusesAServerNoLongerOnTheList(t *testing.T) {
	sessions := t.TempDir()
	aSession(t, sessions, scout, os.Getpid(), Access{Token: "scouts-token", Servers: []string{"company-graph"}, FleetID: fleet, PluginShipID: plugin})
	proxy := httptest.NewServer(Proxy{Sessions: sessions, Configuration: applied(nil, nil)})
	defer proxy.Close()
	if status, text := call(t, proxy, "/mcp/"+scout+"/company-graph", "scouts-token", listTools); status != http.StatusNotFound {
		t.Errorf("tools/list of a server off the list = %d %s, want 404", status, text)
	}
}

func TestAnAccessIsKeptInItsSessionsFolderReadableByItsUserOnly(t *testing.T) {
	folder := t.TempDir()
	if err := WriteAccess(folder, Access{Token: "scouts-token", Servers: []string{"company-graph"}, FleetID: fleet, PluginShipID: plugin}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(folder, "mcp-access"))
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("the access file's mode = %o, want 600", mode)
	}
}

func TestAServersPathAtTheProxyNamesTheShipAndTheServer(t *testing.T) {
	if got, want := PathOf(scout, "company-graph"), "/mcp/"+scout+"/company-graph"; got != want {
		t.Errorf("PathOf(%s, company-graph) = %s, want %s", scout, got, want)
	}
}

func TestTheProxyForwardsNoResourcesOrPromptsRequestAndTheGraphNeverGetsOne(t *testing.T) {
	methods := []string{"resources/list", "resources/read", "resources/templates/list", "resources/subscribe", "prompts/list", "prompts/get"}
	var bodies []string
	for _, method := range methods {
		bodies = append(bodies, `{"jsonrpc":"2.0","id":3,"method":"`+method+`","params":{}}`)
	}
	bodies = append(bodies, "["+callTool("read_neo4j_cypher")+","+bodies[0]+"]")
	for _, body := range bodies {
		graph := &fakeGraph{}
		proxy := aProxy(t, graph)
		_, text := call(t, proxy, "/mcp/"+scout+"/company-graph", "scouts-token", body)
		var answer struct {
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(text), &answer) != nil || answer.Error == nil {
			t.Errorf("%s = %s, want a JSON-RPC error", body, text)
		}
		if graph.requests != 0 {
			t.Errorf("the graph got %d requests for %s, want none", graph.requests, body)
		}
	}
}

func TestTheProxyOffersNoResourcesOrPromptsInTheGraphsCapabilities(t *testing.T) {
	for _, isStream := range []bool{false, true} {
		t.Run("stream "+strconv.FormatBool(isStream), func(t *testing.T) {
			proxy := aProxy(t, &fakeGraph{isStream: isStream})
			_, text := call(t, proxy, "/mcp/"+scout+"/company-graph", "scouts-token", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
			if strings.Contains(text, "resources") || strings.Contains(text, "prompts") {
				t.Errorf("initialize = %s, want capabilities without resources or prompts", text)
			}
			if !strings.Contains(text, `"tools"`) {
				t.Errorf("initialize = %s, want the tools capability kept", text)
			}
		})
	}
}

// aProxyWithCredential is the MCP proxy in front of the graph, listed with a credential in the header, and the secrets it holds.
func aProxyWithCredential(t *testing.T, graph *fakeGraph, header string, held map[string]string) *httptest.Server {
	t.Helper()
	upstream := httptest.NewServer(graph)
	t.Cleanup(upstream.Close)
	sessions := t.TempDir()
	aSession(t, sessions, scout, os.Getpid(), Access{Token: "scouts-token", Servers: []string{"company-graph"}, FleetID: fleet, PluginShipID: plugin})
	list := []mcpservers.Server{{Name: "company-graph", URL: upstream.URL + "/mcp", Transport: mcpservers.Transport, Tools: []string{"read_neo4j_cypher"}, Credential: &mcpservers.Credential{Secret: "graph-token", Header: header}}}
	proxy := httptest.NewServer(Proxy{Sessions: sessions, Configuration: applied(list, held)})
	t.Cleanup(proxy.Close)
	return proxy
}

func TestTheProxyAddsTheServersCredentialInPlaceOfTheSessionsToken(t *testing.T) {
	graph := &fakeGraph{}
	proxy := aProxyWithCredential(t, graph, "Authorization", map[string]string{"graph-token": "Bearer s3cr3t"})

	status, text := call(t, proxy, "/mcp/"+scout+"/company-graph", "scouts-token", listTools)

	if status != http.StatusOK || len(graph.headers) != 1 || graph.headers[0].Get("authorization") != "Bearer s3cr3t" {
		t.Fatalf("tools/list = %d %s, the graph got %v, want Bearer s3cr3t", status, text, graph.headers)
	}
}

func TestTheProxySetsTheCredentialOverWhatTheSessionSentInItsHeader(t *testing.T) {
	graph := &fakeGraph{}
	proxy := aProxyWithCredential(t, graph, "X-Api-Key", map[string]string{"graph-token": "s3cr3t"})
	request, _ := http.NewRequest(http.MethodPost, proxy.URL+"/mcp/"+scout+"/company-graph", strings.NewReader(listTools))
	request.Header.Set("authorization", "Bearer scouts-token")
	request.Header.Add("x-api-key", "the session's own")
	request.Header.Add("x-api-key", "and another")
	answer, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = answer.Body.Close()

	if len(graph.headers) != 1 || !slices.Equal(graph.headers[0].Values("x-api-key"), []string{"s3cr3t"}) || graph.headers[0].Get("authorization") != "" {
		t.Fatalf("the graph got %v, want x-api-key s3cr3t alone and no authorization", graph.headers)
	}
}

func TestTheProxyRefusesAServerWhoseCredentialIsNotHeldAndNeverReachesIt(t *testing.T) {
	graph := &fakeGraph{}
	proxy := aProxyWithCredential(t, graph, "Authorization", map[string]string{"other": "Bearer s3cr3t"})

	status, text := call(t, proxy, "/mcp/"+scout+"/company-graph", "scouts-token", listTools)

	if status != http.StatusServiceUnavailable || graph.requests != 0 || strings.Contains(text, "s3cr3t") {
		t.Fatalf("tools/list = %d %s, the graph got %d requests, want 503 and none", status, text, graph.requests)
	}
}

func TestTheProxyRefusesAServerWithACredentialWhenItHoldsNoSecrets(t *testing.T) {
	graph := &fakeGraph{}
	upstream := httptest.NewServer(graph)
	defer upstream.Close()
	sessions := t.TempDir()
	aSession(t, sessions, scout, os.Getpid(), Access{Token: "scouts-token", Servers: []string{"company-graph"}, FleetID: fleet, PluginShipID: plugin})
	list := []mcpservers.Server{{Name: "company-graph", URL: upstream.URL + "/mcp", Transport: mcpservers.Transport, Tools: []string{"read_neo4j_cypher"}, Credential: &mcpservers.Credential{Secret: "graph-token", Header: "Authorization"}}}
	proxy := httptest.NewServer(Proxy{Sessions: sessions, Configuration: applied(list, nil)})
	defer proxy.Close()

	if status, _ := call(t, proxy, "/mcp/"+scout+"/company-graph", "scouts-token", listTools); status != http.StatusServiceUnavailable || graph.requests != 0 {
		t.Fatalf("tools/list = %d, the graph got %d requests, want 503 and none", status, graph.requests)
	}
}

// aBoundProxy is the MCP proxy in front of the graph, with a running scout session bound to the identity it was started under and the configuration read at each call.
func aBoundProxy(t *testing.T, graph *fakeGraph, bound mcpconfiguration.Identity, configuration func(url string) func() (mcpconfiguration.Configuration, bool)) *httptest.Server {
	t.Helper()
	upstream := httptest.NewServer(graph)
	t.Cleanup(upstream.Close)
	sessions := t.TempDir()
	aSession(t, sessions, scout, os.Getpid(), Access{Token: "scouts-token", Servers: []string{"company-graph"}, FleetID: bound.FleetID, PluginShipID: bound.PluginShipID})
	proxy := httptest.NewServer(Proxy{Sessions: sessions, Configuration: configuration(upstream.URL + "/mcp")})
	t.Cleanup(proxy.Close)
	return proxy
}

func TestTheProxyRefusesEveryCallOfASessionBoundToAReplacedIdentityAndForwardsNothing(t *testing.T) {
	ours := mcpconfiguration.Identity{FleetID: fleet, PluginShipID: plugin}
	for _, test := range []struct {
		label   string
		bound   mcpconfiguration.Identity
		applied mcpconfiguration.Identity
	}{
		{"a configuration of another plugin ship applied since", ours, mcpconfiguration.Identity{FleetID: fleet, PluginShipID: "shp_01m3tb1zhjs6kthtcs2zvksacw"}},
		{"a configuration of another fleet applied since", ours, mcpconfiguration.Identity{FleetID: "flt_01m3tb1zgr5h2ffee12xnch8sw", PluginShipID: plugin}},
		{"a session started before it was bound to any", mcpconfiguration.Identity{}, ours},
	} {
		t.Run(test.label, func(t *testing.T) {
			graph := &fakeGraph{}
			proxy := aBoundProxy(t, graph, test.bound, func(url string) func() (mcpconfiguration.Configuration, bool) {
				// The newly applied configuration names a server of the same name.
				return appliedAs(test.applied, []mcpservers.Server{{Name: "company-graph", URL: url, Transport: mcpservers.Transport, Tools: []string{"read_neo4j_cypher"}}}, nil)
			})

			for _, body := range []string{listTools, callTool("read_neo4j_cypher")} {
				status, text := call(t, proxy, "/mcp/"+scout+"/company-graph", "scouts-token", body)
				if status != http.StatusForbidden || !strings.Contains(text, "MCP_CONFIGURATION_IDENTITY_MISMATCH") {
					t.Errorf("%s = %d %s, want 403 MCP_CONFIGURATION_IDENTITY_MISMATCH", body, status, text)
				}
			}
			if graph.requests != 0 {
				t.Errorf("the graph got %d requests, want none", graph.requests)
			}
		})
	}
}

func TestTheProxyRefusesASessionBoundToAnIdentityWhenNoConfigurationIsApplied(t *testing.T) {
	graph := &fakeGraph{}
	proxy := aBoundProxy(t, graph, mcpconfiguration.Identity{FleetID: fleet, PluginShipID: plugin}, func(string) func() (mcpconfiguration.Configuration, bool) {
		return func() (mcpconfiguration.Configuration, bool) { return mcpconfiguration.Configuration{}, false }
	})

	status, text := call(t, proxy, "/mcp/"+scout+"/company-graph", "scouts-token", listTools)

	if status != http.StatusForbidden || !strings.Contains(text, "MCP_CONFIGURATION_IDENTITY_MISMATCH") || graph.requests != 0 {
		t.Errorf("tools/list with none applied = %d %s, the graph got %d, want 403 MCP_CONFIGURATION_IDENTITY_MISMATCH and none", status, text, graph.requests)
	}
}

func TestARotatedCredentialAndAChangedAllowlistTakeEffectOnTheNextCallAfterTheyAreApplied(t *testing.T) {
	graph := &fakeGraph{}
	var current mcpconfiguration.Configuration
	proxy := aBoundProxy(t, graph, mcpconfiguration.Identity{FleetID: fleet, PluginShipID: plugin}, func(url string) func() (mcpconfiguration.Configuration, bool) {
		current = mcpconfiguration.Configuration{Identity: mcpconfiguration.Identity{FleetID: fleet, PluginShipID: plugin}, Version: 1, Servers: []mcpservers.Server{{Name: "company-graph", URL: url, Transport: mcpservers.Transport, Tools: []string{"read_neo4j_cypher"}, Credential: &mcpservers.Credential{Secret: "graph-token", Header: "Authorization"}}}, Secrets: map[string]string{"graph-token": "Bearer first"}}
		return func() (mcpconfiguration.Configuration, bool) { return current, true }
	})
	call(t, proxy, "/mcp/"+scout+"/company-graph", "scouts-token", callTool("read_neo4j_cypher"))

	rotated := current
	rotated.Version = 2
	rotated.Servers = []mcpservers.Server{{Name: "company-graph", URL: current.Servers[0].URL, Transport: mcpservers.Transport, Tools: []string{"get_neo4j_schema"}, Credential: current.Servers[0].Credential}}
	rotated.Secrets = map[string]string{"graph-token": "Bearer second"}
	current = rotated
	call(t, proxy, "/mcp/"+scout+"/company-graph", "scouts-token", callTool("get_neo4j_schema"))
	_, text := call(t, proxy, "/mcp/"+scout+"/company-graph", "scouts-token", callTool("read_neo4j_cypher"))

	if len(graph.headers) != 2 || graph.headers[0].Get("authorization") != "Bearer first" || graph.headers[1].Get("authorization") != "Bearer second" {
		t.Errorf("the graph got %v, want Bearer first, then Bearer second", graph.headers)
	}
	if got := graph.calls(); !slices.Equal(got, []string{"read_neo4j_cypher", "get_neo4j_schema"}) || !strings.Contains(text, "read_neo4j_cypher") {
		t.Errorf("the graph was called with %v and the dropped tool answered %s, want the dropped tool refused", got, text)
	}
}

func TestAnAccessKeepsTheIdentityItsSessionWasStartedUnderAcrossARestartOfTheProxy(t *testing.T) {
	folder := t.TempDir()
	written := Access{Token: "scouts-token", Servers: []string{"company-graph"}, FleetID: fleet, PluginShipID: plugin}
	if err := WriteAccess(folder, written); err != nil {
		t.Fatal(err)
	}

	read, ok := readAccess(folder)

	if !ok || read.FleetID != fleet || read.PluginShipID != plugin {
		t.Errorf("readAccess = %+v, %v, want the fleet and plugin ship it was written with", read, ok)
	}
}

func TestThePermissionServerNeedsNoRemoteConfigurationAndReturnsOneTextDenial(t *testing.T) {
	sessions := t.TempDir()
	aSession(t, sessions, scout, os.Getpid(), Access{Token: "permission-token", Servers: []string{"aeolus-permissions"}})
	proxy := Proxy{Sessions: sessions}
	request := httptest.NewRequest(http.MethodPost, PathOf(scout, "aeolus-permissions"), strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ask","arguments":{"tool_name":"Bash","input":{"command":"touch denied"},"tool_use_id":"use-1"}}}`))
	request.Header.Set("Authorization", "Bearer permission-token")
	answer := httptest.NewRecorder()
	proxy.ServeHTTP(answer, request)
	var got struct {
		Result struct {
			Content []struct {
				Type string
				Text string
			}
		}
	}
	if err := json.Unmarshal(answer.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if answer.Code != 200 || len(got.Result.Content) != 1 || got.Result.Content[0].Type != "text" || got.Result.Content[0].Text != `{"behavior":"deny","message":"could not read this ship's owner: nobody is asked"}` {
		t.Fatalf("answer = %d %s, want one JSON text denial", answer.Code, answer.Body.String())
	}
}

func TestThePermissionServerRefusesAnotherShipStoppedSessionsAndBypassSessions(t *testing.T) {
	for _, test := range []struct {
		name    string
		pid     int
		servers []string
		token   string
	}{
		{"another token", os.Getpid(), []string{"aeolus-permissions"}, "another-session"},
		{"stopped session", stoppedPID, []string{"aeolus-permissions"}, "permission-token"},
		{"bypass session", os.Getpid(), nil, "permission-token"},
	} {
		t.Run(test.name, func(t *testing.T) {
			sessions := t.TempDir()
			aSession(t, sessions, scout, test.pid, Access{Token: "permission-token", Servers: test.servers})
			request := httptest.NewRequest(http.MethodPost, PathOf(scout, "aeolus-permissions"), strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ask"}}`))
			request.Header.Set("Authorization", "Bearer "+test.token)
			answer := httptest.NewRecorder()
			(Proxy{Sessions: sessions}).ServeHTTP(answer, request)
			if answer.Code != http.StatusUnauthorized || AuthorizesPermission(sessions, scout, test.token) {
				t.Fatalf("access = %d, want unauthorized", answer.Code)
			}
		})
	}
}
