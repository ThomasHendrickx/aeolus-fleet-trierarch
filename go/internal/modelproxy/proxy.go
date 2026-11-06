// Package modelproxy is the model proxy (headless H16, api keys K7): the one
// process that reads a harness's API key. A session reaches its vendor
// through it with a token of its own; the proxy takes the token only from a
// running session of that harness, swaps it for the key, and forwards the
// request to that harness's vendor alone: `/anthropic/...` to Anthropic for
// Claude Code, `/openai/...` to OpenAI for Codex. Its refusals name neither a
// key nor a token. It reads every vendor answer to the key and records what
// it says of the key (K9): a success before it streams, an error once whole,
// before it is sent on unchanged.
package modelproxy

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/keys"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/proxytoken"
)

const (
	// StatePath is the proxy's own path, which answers its version.
	StatePath = "/aeolus/state"
	// CheckPath is the proxy's own path that checks a harness's key at once, `<path><harness>` (login --check, K10).
	CheckPath = "/aeolus/check/"
	// CheckEvery is how often a key out of credit is checked (K10).
	CheckEvery = 15 * time.Minute
)

// Harnesses are the harnesses the proxy keeps a key for.
var Harnesses = []string{"claude-code", "codex"}

// vendorURLs are each harness's vendor.
var vendorURLs = map[string]string{"claude-code": "https://api.anthropic.com", "codex": "https://api.openai.com"}

// prefixes are the path each harness's base URL ends in, which names its vendor.
var prefixes = map[string]string{"anthropic": "claude-code", "openai": "codex"}

// cheapest are each vendor's cheapest models, by a word in their ids, cheapest first: the check spends as little as the vendor bills.
var cheapest = map[string][]string{"claude-code": {"haiku"}, "codex": {"nano", "mini"}}

const (
	anthropicVersion = "2023-06-01"
	// openAIFewestOutputTokens is the fewest output tokens the Responses API takes.
	openAIFewestOutputTokens = 16
	// errorBodyRead is how much of an error's body is read for what it says of the key: a vendor's error is a short JSON object.
	errorBodyRead = 64 * 1024
	checkTimeout  = 15 * time.Second
	onlyVendors   = "it forwards only to the harnesses' vendors"
)

var bearer = regexp.MustCompile(`^Bearer (\S+)$`)

// Proxy is the model proxy's handler.
type Proxy struct {
	// Sessions is the sessions folder, where each session keeps its token.
	Sessions string
	Keys     keys.Files
	States   keys.States
	Version  string
	// Vendors replace a harness's vendor's origin, as a test does; each harness's own otherwise.
	Vendors map[string]string
	Now     func() time.Time
}

func (p Proxy) vendorOf(harness string) string {
	if origin, ok := p.Vendors[harness]; ok {
		return origin
	}
	return vendorURLs[harness]
}

// keyHeaders are the headers the key travels in to the harness's vendor.
func keyHeaders(harness string, key string) map[string]string {
	if harness == "claude-code" {
		return map[string]string{"x-api-key": key}
	}
	return map[string]string{"authorization": "Bearer " + key}
}

func refuse(w http.ResponseWriter, status int, message string) {
	kind := "not_found_error"
	if status == http.StatusUnauthorized {
		kind = "authentication_error"
	}
	writeJSON(w, status, map[string]any{"type": "error", "error": map[string]string{"type": kind, "message": "aeolus model proxy: " + message}})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	text, _ := json.Marshal(value)
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(text)
}

// record keeps what the vendor's answer said of the key, before the answer goes on, so the trierarch knows the key's state by the time the session does; a failed write is tried again on the next answer.
func (p Proxy) record(harness string, status int, body string) {
	if said := keys.StateOfAnswer(harness, status, body); said != "" {
		_ = p.States.Record(harness, said, p.Now())
	}
}

func (p Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.EscapedPath()
	if harness, ok := strings.CutPrefix(path, CheckPath); ok && r.Method == http.MethodPost && isHarness(harness) {
		if p.States.StateOf(harness).State == keys.OutOfCredit {
			p.checkKey(harness)
		}
		writeJSON(w, http.StatusOK, p.States.StateOf(harness))
		return
	}
	if path == StatePath {
		writeJSON(w, http.StatusOK, map[string]string{"version": p.Version})
		return
	}
	prefix, rest, _ := strings.Cut(strings.TrimPrefix(path, "/"), "/")
	harness, ok := prefixes[prefix]
	if !ok {
		refuse(w, http.StatusNotFound, onlyVendors)
		return
	}
	token := r.Header.Get("x-api-key")
	if match := bearer.FindStringSubmatch(r.Header.Get("authorization")); match != nil {
		token = match[1]
	}
	if _, ok := proxytoken.SessionOf(p.Sessions, harness, token); !ok {
		refuse(w, http.StatusUnauthorized, "not the token of a running session of this harness")
		return
	}
	key, ok := p.Keys.Read(harness)
	if !ok {
		refuse(w, http.StatusUnauthorized, "this computer holds no API key for "+harness)
		return
	}
	// The vendor's origin is fixed, and the path only ever set on it: a path is never resolved as a URL, which could name another host.
	origin, err := url.Parse(p.vendorOf(harness))
	if err != nil {
		refuse(w, http.StatusNotFound, onlyVendors)
		return
	}
	target := &url.URL{Scheme: origin.Scheme, Host: origin.Host, RawQuery: r.URL.RawQuery}
	target.RawPath = "/" + rest
	if target.Path, err = url.PathUnescape(target.RawPath); err != nil {
		refuse(w, http.StatusNotFound, onlyVendors)
		return
	}
	if r.ContentLength > 0 {
		// The server closes the request body once the answer begins; the vendor's connection reading it again after that would fail and close, cutting the stream. A body of known length is read to its length and no further.
		r.Body = struct {
			io.Reader
			io.Closer
		}{io.LimitReader(r.Body, r.ContentLength), r.Body}
	}
	forward := &httputil.ReverseProxy{
		Rewrite: func(out *httputil.ProxyRequest) {
			out.Out.URL = target
			out.Out.Host = ""
			out.Out.Header.Del("authorization")
			out.Out.Header.Del("x-api-key")
			for name, value := range keyHeaders(harness, key) {
				out.Out.Header.Set(name, value)
			}
		},
		// A stream goes on as the vendor writes it.
		FlushInterval: -1,
		ModifyResponse: func(answer *http.Response) error {
			if answer.StatusCode < 300 {
				p.record(harness, answer.StatusCode, "")
				return nil
			}
			body, err := io.ReadAll(answer.Body)
			_ = answer.Body.Close()
			if err != nil {
				return err
			}
			p.record(harness, answer.StatusCode, string(body[:min(len(body), errorBodyRead)]))
			answer.Body = io.NopCloser(bytes.NewReader(body))
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			refuse(w, http.StatusBadGateway, target.Host+" could not be reached")
		},
	}
	forward.ServeHTTP(w, r)
}

func isHarness(name string) bool {
	_, ok := vendorURLs[name]
	return ok
}

// CheckOutOfCredit checks each key out of credit once (K10), as the proxy does every 15 minutes.
func CheckOutOfCredit(p Proxy) {
	for _, harness := range Harnesses {
		if p.States.StateOf(harness).State == keys.OutOfCredit {
			p.checkKey(harness)
		}
	}
}

// checkKey sends one request the vendor bills, on its cheapest model it lists for the key, and records what its answer says of the key.
func (p Proxy) checkKey(harness string) {
	key, ok := p.Keys.Read(harness)
	if !ok {
		return
	}
	client := http.Client{Timeout: checkTimeout}
	vendor := p.vendorOf(harness)
	headers := keyHeaders(harness, key)
	if harness == "claude-code" {
		headers["anthropic-version"] = anthropicVersion
	}
	send := func(method string, path string, body any) (*http.Response, error) {
		var reader io.Reader
		if body != nil {
			text, _ := json.Marshal(body)
			reader = bytes.NewReader(text)
		}
		request, err := http.NewRequest(method, vendor+path, reader)
		if err != nil {
			return nil, err
		}
		for name, value := range headers {
			request.Header.Set(name, value)
		}
		if body != nil {
			request.Header.Set("content-type", "application/json")
		}
		return client.Do(request)
	}
	listed, err := send(http.MethodGet, "/v1/models", nil)
	if err != nil {
		return
	}
	var models struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	_ = json.NewDecoder(listed.Body).Decode(&models)
	_ = listed.Body.Close()
	model := ""
	for _, word := range cheapest[harness] {
		for _, each := range models.Data {
			if model == "" && strings.Contains(each.ID, word) {
				model = each.ID
			}
		}
	}
	if model == "" {
		return
	}
	path, body := "/v1/messages", any(map[string]any{"model": model, "max_tokens": 1, "messages": []map[string]string{{"role": "user", "content": "Hi"}}})
	if harness == "codex" {
		path, body = "/v1/responses", map[string]any{"model": model, "input": "Hi", "max_output_tokens": openAIFewestOutputTokens}
	}
	answer, err := send(http.MethodPost, path, body)
	if err != nil {
		return
	}
	text, _ := io.ReadAll(io.LimitReader(answer.Body, errorBodyRead))
	_ = answer.Body.Close()
	p.record(harness, answer.StatusCode, string(text))
}
