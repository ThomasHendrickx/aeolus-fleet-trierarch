// Package mcpservers is the crew-time MCP servers (docs/design/crew-mcp-servers.md,
// decisions M2, M4 and M7): the servers of a fleet's MCP configuration
// (package mcpconfiguration), the remote servers a ship may be crewed with, each by the name a crew request's
// mcpServers gives it, its URL, the tools a session may call and, for one that
// needs it, its credential: the name of a secret the trierarch plugin seals to
// each trierarch (package secrets) and the header the MCP proxy sets it in. A
// trierarch reads the list as strictly as the trierarch plugin wrote it: no
// entry holds a credential's value, so a URL has no user, query or fragment,
// and an entry has no field beyond the five.
package mcpservers

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"unicode"
)

// Transport is the one transport a server is reached over (decision M8); an entry that names none has it.
const Transport = "streamable-http"

// nameMaxLength is the most a name holds, as common gives it.
const nameMaxLength = 100

var namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)

// Server is a remote MCP server a session may be crewed with: its name, its URL, its transport, the tools a session may call and the credential it needs, if any.
type Server struct {
	Name       string      `json:"name"`
	URL        string      `json:"url"`
	Transport  string      `json:"transport"`
	Tools      []string    `json:"tools"`
	Credential *Credential `json:"credential,omitempty"`
}

// Credential is how the MCP proxy adds a server's credential to what it forwards: the header it sets to the secret's value, as the secret holds it. It names the secret, never holds its value.
type Credential struct {
	Secret string `json:"secret"`
	Header string `json:"header"`
}

// headerPattern is an RFC 9110 field name.
var headerPattern = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

// reservedHeaders are the headers a credential cannot be set in: those of the connection, the proxy's own and the MCP session's, which the proxy forwards as the session sends them.
var reservedHeaders = []string{"host", "content-length", "content-type", "transfer-encoding", "connection", "upgrade", "te", "trailer", "keep-alive", "cookie", "accept", "accept-encoding", "mcp-session-id", "mcp-protocol-version", "last-event-id"}

// credentialProblem is why a credential cannot be used, empty when it can.
func credentialProblem(credential Credential) string {
	if credential.Secret == "" || nameProblem(credential.Secret) != "" {
		return "a credential names its secret, by a name as a server's"
	}
	lower := strings.ToLower(credential.Header)
	if !headerPattern.MatchString(credential.Header) || slices.Contains(reservedHeaders, lower) || strings.HasPrefix(lower, "proxy-") {
		return "a credential names the header it is set in, which is not one of the connection's, a proxy's or the MCP session's"
	}
	return ""
}

var errURLRefused = errors.New("an MCP server is an http:// or https:// URL with a host and no user, query or fragment, never a credential")

func isReachable(text string) bool {
	if strings.IndexFunc(text, unicode.IsSpace) >= 0 {
		return false
	}
	parsed, err := url.Parse(text)
	if err != nil {
		return false
	}
	return (parsed.Scheme == "https" || parsed.Scheme == "http") && parsed.Hostname() != "" && parsed.User == nil && parsed.RawQuery == "" && !parsed.ForceQuery && parsed.Fragment == "" && !strings.Contains(text, "#")
}

func nameProblem(name string) string {
	switch {
	case len(name) > nameMaxLength:
		return fmt.Sprintf("A name is at most %d characters", nameMaxLength)
	case !namePattern.MatchString(name):
		return "A name is lowercase letters, digits, dots, hyphens and underscores, and never a path"
	}
	return ""
}

// entryOf reads one entry, refusing a field beyond the five, or one in its credential beyond the two.
func entryOf(raw json.RawMessage) (Server, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) == nil && string(fields["credential"]) == "null" {
		return Server{}, errors.New("a credential is an object, or left out")
	}
	var server Server
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&server); err != nil {
		return Server{}, err
	}
	return server, nil
}

// Read is the list from the message's payload, or why not: each name a name given once, each URL one a session can be pointed at without a credential, each server with the tools a session may call.
func Read(payload string) ([]Server, error) {
	if !json.Valid([]byte(payload)) {
		return nil, errors.New("the MCP servers are not JSON")
	}
	shape := errors.New(`the MCP servers are { "servers": [{ "name", "url", "transport"?, "tools" }] }`)
	var message struct {
		Servers json.RawMessage `json:"servers"`
	}
	if json.Unmarshal([]byte(payload), &message) != nil {
		return nil, shape
	}
	var entries []json.RawMessage
	if len(message.Servers) == 0 || string(message.Servers) == "null" || json.Unmarshal(message.Servers, &entries) != nil {
		return nil, shape
	}
	list := []Server{}
	for _, raw := range entries {
		if string(raw) == "null" {
			return nil, shape
		}
		server, err := entryOf(raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", nameIn(raw), err)
		}
		if server.Name == "aeolus-permissions" {
			return nil, errors.New("aeolus-permissions is reserved for the permission tool")
		}
		if problem := nameProblem(server.Name); problem != "" {
			return nil, fmt.Errorf("%s: %s", server.Name, problem)
		}
		if slices.ContainsFunc(list, func(each Server) bool { return each.Name == server.Name }) {
			return nil, fmt.Errorf("%s: an MCP server is named once", server.Name)
		}
		if !isReachable(server.URL) {
			return nil, fmt.Errorf("%s: %w", server.Name, errURLRefused)
		}
		if server.Transport == "" {
			server.Transport = Transport
		}
		if server.Transport != Transport {
			return nil, fmt.Errorf("%s: the transport is %s, the only one", server.Name, Transport)
		}
		if len(server.Tools) == 0 {
			return nil, fmt.Errorf("%s: an MCP server names the tools a session may call", server.Name)
		}
		for index, tool := range server.Tools {
			if tool == "" || strings.IndexFunc(tool, unicode.IsSpace) >= 0 {
				return nil, fmt.Errorf("%s: %q is no tool name", server.Name, tool)
			}
			if slices.Contains(server.Tools[:index], tool) {
				return nil, fmt.Errorf("%s: the tool %s is named once", server.Name, tool)
			}
		}
		if server.Credential != nil {
			if problem := credentialProblem(*server.Credential); problem != "" {
				return nil, fmt.Errorf("%s: %s", server.Name, problem)
			}
		}
		list = append(list, server)
	}
	return list, nil
}

// WithCredentialHeld are the servers on the list that need no credential or whose secret is held: one whose secret is missing cannot be given (decision M4).
func WithCredentialHeld(list []Server, secrets []string) []Server {
	held := []Server{}
	for _, server := range list {
		if server.Credential == nil || slices.Contains(secrets, server.Credential.Secret) {
			held = append(held, server)
		}
	}
	return held
}

// nameIn is the name an entry that did not decode gives, or its position-free placeholder.
func nameIn(raw json.RawMessage) string {
	var named struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(raw, &named) != nil || named.Name == "" {
		return "an entry"
	}
	return named.Name
}

// OfferedBy are, by harness, the names of the servers on the list that it can be started with, as canAdd says by a server's name: a harness missing from canAdd offers none, and one offers no server it cannot add (decision M4).
func OfferedBy(list []Server, harnesses []string, canAdd map[string]func(name string) bool) map[string][]string {
	offered := map[string][]string{}
	for _, harness := range harnesses {
		names := []string{}
		if adds, ok := canAdd[harness]; ok {
			for _, server := range list {
				if adds(server.Name) {
					names = append(names, server.Name)
				}
			}
		}
		offered[harness] = names
	}
	return offered
}
