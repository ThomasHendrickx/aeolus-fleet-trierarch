package modelproxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/keys"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/proxytoken"
)

const (
	scout       = "shp_01m6jyczpnpp5c0vxh54c966cy"
	anthropic   = "sk-ant-api03-proxy-test-key"
	openai      = "sk-proj-proxy-test-key"
	scoutsToken = "scouts-proxy-token"
)

var monday = time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)

// seen is a request a vendor stand-in was sent.
type seen struct {
	Method string
	Path   string
	Query  string
	Header http.Header
	Body   string
}

// vendor is a stand-in for a harness's vendor: it keeps what it was sent and answers as told.
type vendor struct {
	mutex  sync.Mutex
	seen   []seen
	answer func(w http.ResponseWriter, r *http.Request)
	server *httptest.Server
}

func aVendor(t *testing.T) *vendor {
	t.Helper()
	v := &vendor{answer: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.Header().Set("request-id", "req_1")
		_, _ = io.WriteString(w, `{"id":"msg_1"}`)
	}}
	v.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		v.mutex.Lock()
		v.seen = append(v.seen, seen{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Header: r.Header.Clone(), Body: string(body)})
		v.mutex.Unlock()
		v.answer(w, r)
	}))
	t.Cleanup(v.server.Close)
	return v
}

func (v *vendor) requests() []seen {
	v.mutex.Lock()
	defer v.mutex.Unlock()
	return append([]seen{}, v.seen...)
}

type machine struct {
	proxy     *httptest.Server
	anthropic *vendor
	openai    *vendor
	keys      keys.Files
	states    keys.States
	sessions  string
}

// aMachine runs the proxy with Claude Code's and Codex's keys, and scout's session of Claude Code running with its token.
func aMachine(t *testing.T) *machine {
	t.Helper()
	home := t.TempDir()
	m := &machine{anthropic: aVendor(t), openai: aVendor(t), keys: keys.Files{Folder: filepath.Join(home, "keys")}, sessions: filepath.Join(home, "sessions")}
	m.states = keys.States{Keys: m.keys.Folder, File: filepath.Join(home, "proxy", "key-states.json")}
	for harness, key := range map[string]string{"claude-code": anthropic, "codex": openai} {
		if err := m.keys.Write(harness, key); err != nil {
			t.Fatal(err)
		}
	}
	aRunningSession(t, m.sessions, scout, proxytoken.Token{Harness: "claude-code", Token: scoutsToken})
	proxy := Proxy{Sessions: m.sessions, Keys: m.keys, States: m.states, Version: "0.0.0-go", Vendors: map[string]string{"claude-code": m.anthropic.server.URL, "codex": m.openai.server.URL}, Now: func() time.Time { return monday }}
	m.proxy = httptest.NewServer(proxy)
	t.Cleanup(m.proxy.Close)
	return m
}

func aRunningSession(t *testing.T, sessions string, shipID string, token proxytoken.Token) {
	t.Helper()
	folder := filepath.Join(sessions, shipID)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "hold.pid"), []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := proxytoken.Write(folder, token); err != nil {
		t.Fatal(err)
	}
}

func (m *machine) call(t *testing.T, method string, path string, header map[string]string, body string) (int, http.Header, string) {
	t.Helper()
	request, err := http.NewRequest(method, m.proxy.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range header {
		request.Header.Set(name, value)
	}
	answer, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer answer.Body.Close()
	text, _ := io.ReadAll(answer.Body)
	return answer.StatusCode, answer.Header, string(text)
}

func TestTheProxyAnswersItsVersion(t *testing.T) {
	m := aMachine(t)

	status, _, body := m.call(t, "GET", "/aeolus/state", nil, "")

	if status != 200 || body != `{"version":"0.0.0-go"}` {
		t.Fatalf("GET /aeolus/state = %d %s, want 200 {\"version\":\"0.0.0-go\"}", status, body)
	}
}

func TestASessionsCallReachesItsVendorWithTheKeyInPlaceOfItsToken(t *testing.T) {
	m := aMachine(t)

	status, header, body := m.call(t, "POST", "/anthropic/v1/messages?beta=true", map[string]string{"authorization": "Bearer " + scoutsToken, "anthropic-version": "2023-06-01", "content-type": "application/json"}, `{"model":"claude"}`)

	if status != 200 || body != `{"id":"msg_1"}` || header.Get("request-id") != "req_1" {
		t.Fatalf("answer = %d %s %v, want the vendor's answer unchanged", status, body, header)
	}
	sent := m.anthropic.requests()
	if len(sent) != 1 {
		t.Fatalf("the vendor was sent %d requests, want 1", len(sent))
	}
	got := sent[0]
	if got.Method != "POST" || got.Path != "/v1/messages" || got.Query != "beta=true" || got.Body != `{"model":"claude"}` {
		t.Fatalf("the vendor was sent %+v, want POST /v1/messages?beta=true with the body", got)
	}
	if got.Header.Get("x-api-key") != anthropic || got.Header.Get("authorization") != "" || got.Header.Get("anthropic-version") != "2023-06-01" {
		t.Fatalf("the vendor was sent the headers %v, want the key as x-api-key, no authorization, the rest kept", got.Header)
	}
}

func TestATokenSentAsTheAPIKeyHeaderIsTakenToo(t *testing.T) {
	m := aMachine(t)

	status, _, _ := m.call(t, "POST", "/anthropic/v1/messages", map[string]string{"x-api-key": scoutsToken}, "{}")

	if status != 200 || m.anthropic.requests()[0].Header.Get("x-api-key") != anthropic {
		t.Fatalf("answer = %d, want 200 with the key sent in place of the token", status)
	}
}

func TestACodexSessionsCallReachesOpenAIWithTheKeyAsItsBearer(t *testing.T) {
	m := aMachine(t)
	aRunningSession(t, m.sessions, "shp_01m6jyczpnpp5c0vxh54c966cz", proxytoken.Token{Harness: "codex", Token: "builders-token"})

	status, _, _ := m.call(t, "POST", "/openai/v1/responses", map[string]string{"authorization": "Bearer builders-token"}, "{}")

	sent := m.openai.requests()
	if status != 200 || len(sent) != 1 || sent[0].Path != "/v1/responses" || sent[0].Header.Get("authorization") != "Bearer "+openai {
		t.Fatalf("answer = %d, sent %+v, want /v1/responses with the key as its bearer", status, sent)
	}
}

func TestACallIsRefusedWithoutTheTokenOfARunningSessionOfThatHarnessNamingNoKeyOrToken(t *testing.T) {
	m := aMachine(t)
	cases := []struct {
		name   string
		path   string
		header map[string]string
	}{
		{"no token", "/anthropic/v1/messages", nil},
		{"another token", "/anthropic/v1/messages", map[string]string{"authorization": "Bearer not-a-session-token"}},
		{"another harness's route", "/openai/v1/responses", map[string]string{"authorization": "Bearer " + scoutsToken}},
	}
	for _, each := range cases {
		status, _, body := m.call(t, "POST", each.path, each.header, "{}")
		if status != 401 || strings.Contains(body, anthropic) || strings.Contains(body, openai) || strings.Contains(body, scoutsToken) || strings.Contains(body, "not-a-session-token") {
			t.Errorf("%s: answer = %d %s, want 401 naming no key or token", each.name, status, body)
		}
	}
	if len(m.anthropic.requests())+len(m.openai.requests()) != 0 {
		t.Fatal("a refused call reached a vendor")
	}
}

func TestACallForAHarnessWithNoKeyIsRefused(t *testing.T) {
	m := aMachine(t)
	if _, err := m.keys.Remove("claude-code"); err != nil {
		t.Fatal(err)
	}

	status, _, body := m.call(t, "POST", "/anthropic/v1/messages", map[string]string{"authorization": "Bearer " + scoutsToken}, "{}")

	if status != 401 || !strings.Contains(body, "holds no API key for claude-code") || len(m.anthropic.requests()) != 0 {
		t.Fatalf("answer = %d %s, want 401 saying claude-code holds no key", status, body)
	}
}

func TestACallToAnythingButAVendorIsRefused(t *testing.T) {
	m := aMachine(t)

	status, _, body := m.call(t, "POST", "/github/v1/repos", map[string]string{"authorization": "Bearer " + scoutsToken}, "{}")

	if status != 404 || !strings.Contains(body, "only to the harnesses' vendors") {
		t.Fatalf("answer = %d %s, want 404", status, body)
	}
}

func TestAPathNamingAnotherHostStillGoesToTheVendor(t *testing.T) {
	m := aMachine(t)

	status, _, _ := m.call(t, "GET", "/anthropic//evil.example/v1/models", map[string]string{"authorization": "Bearer " + scoutsToken}, "")

	sent := m.anthropic.requests()
	if status != 200 || len(sent) != 1 || sent[0].Path != "//evil.example/v1/models" {
		t.Fatalf("answer = %d, sent %+v, want the vendor sent the path as a path", status, sent)
	}
}

func TestAVendorThatCannotBeReachedIsA502NamingItsHost(t *testing.T) {
	m := aMachine(t)
	m.anthropic.server.Close()

	status, _, body := m.call(t, "POST", "/anthropic/v1/messages", map[string]string{"authorization": "Bearer " + scoutsToken}, "{}")

	if status != 502 || !strings.Contains(body, "could not be reached") || strings.Contains(body, anthropic) {
		t.Fatalf("answer = %d %s, want 502", status, body)
	}
}

func TestWhatTheVendorAnswersOfTheKeyIsRecordedBeforeTheAnswerGoesOn(t *testing.T) {
	m := aMachine(t)
	m.anthropic.answer = func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		_, _ = io.WriteString(w, `{"type":"error","error":{"type":"billing_error","message":"Your credit balance is too low"}}`)
	}

	status, _, body := m.call(t, "POST", "/anthropic/v1/messages", map[string]string{"authorization": "Bearer " + scoutsToken}, "{}")

	if status != 400 || !strings.Contains(body, "billing_error") {
		t.Fatalf("answer = %d %s, want the vendor's 400 unchanged", status, body)
	}
	if got := m.states.StateOf("claude-code"); got.State != keys.OutOfCredit || got.At != "2026-11-02T09:00:00.000Z" {
		t.Fatalf("StateOf(claude-code) = %+v, want outOfCredit since monday", got)
	}
}

func TestASuccessStreamsAsTheVendorWritesIt(t *testing.T) {
	m := aMachine(t)
	release := make(chan struct{})
	m.anthropic.answer = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, "event: message_start\n\n")
		w.(http.Flusher).Flush()
		<-release
		_, _ = io.WriteString(w, "event: message_stop\n\n")
	}
	request, _ := http.NewRequest("POST", m.proxy.URL+"/anthropic/v1/messages", strings.NewReader("{}"))
	request.Header.Set("authorization", "Bearer "+scoutsToken)

	answer, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer answer.Body.Close()
	first := make([]byte, len("event: message_start\n\n"))
	if _, err := io.ReadFull(answer.Body, first); err != nil || string(first) != "event: message_start\n\n" {
		t.Fatalf("first event = %q, %v, want it before the vendor ended its answer", first, err)
	}
	close(release)
	rest, _ := io.ReadAll(answer.Body)
	if string(rest) != "event: message_stop\n\n" {
		t.Fatalf("rest = %q, want the last event", rest)
	}
}

func outOfCreditVendor(t *testing.T, m *machine, credit *bool) {
	t.Helper()
	m.anthropic.answer = func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "GET" && r.URL.Path == "/v1/models":
			_, _ = io.WriteString(w, `{"data":[{"id":"claude-opus-5-5"},{"id":"claude-haiku-5-5"},{"id":"claude-sonnet-5-5"}]}`)
		case *credit:
			_, _ = io.WriteString(w, `{"id":"msg_1"}`)
		default:
			w.WriteHeader(400)
			_, _ = io.WriteString(w, `{"type":"error","error":{"type":"billing_error","message":"x"}}`)
		}
	}
}

func TestAKeyOutOfCreditIsCheckedWithOneTokenOnTheCheapestModelItsVendorLists(t *testing.T) {
	m := aMachine(t)
	credit := false
	outOfCreditVendor(t, m, &credit)
	if err := m.states.Record("claude-code", keys.OutOfCredit, monday); err != nil {
		t.Fatal(err)
	}
	credit = true

	status, _, body := m.call(t, "POST", "/aeolus/check/claude-code", nil, "")

	if status != 200 || body != `{"state":"ready"}` {
		t.Fatalf("POST /aeolus/check/claude-code = %d %s, want 200 ready", status, body)
	}
	sent := m.anthropic.requests()
	var check struct {
		Model     string `json:"model"`
		MaxTokens int    `json:"max_tokens"`
	}
	if len(sent) != 2 || sent[1].Path != "/v1/messages" || json.Unmarshal([]byte(sent[1].Body), &check) != nil || check.Model != "claude-haiku-5-5" || check.MaxTokens != 1 || sent[1].Header.Get("x-api-key") != anthropic {
		t.Fatalf("the vendor was sent %+v, want the model list then one token on claude-haiku-5-5", sent)
	}
}

func TestAKeyStillOutOfCreditStaysSoSinceItWasFirstSaid(t *testing.T) {
	m := aMachine(t)
	credit := false
	outOfCreditVendor(t, m, &credit)
	if err := m.states.Record("claude-code", keys.OutOfCredit, monday.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}

	CheckOutOfCredit(Proxy{Sessions: m.sessions, Keys: m.keys, States: m.states, Vendors: map[string]string{"claude-code": m.anthropic.server.URL}, Now: func() time.Time { return monday }})

	if got := m.states.StateOf("claude-code"); got.State != keys.OutOfCredit || got.At != "2026-11-02T08:00:00.000Z" {
		t.Fatalf("StateOf = %+v, want still outOfCredit since 08:00", got)
	}
}

func TestAReadyKeyIsNotChecked(t *testing.T) {
	m := aMachine(t)

	status, _, body := m.call(t, "POST", "/aeolus/check/claude-code", nil, "")

	if status != 200 || body != `{"state":"ready"}` || len(m.anthropic.requests()) != 0 {
		t.Fatalf("answer = %d %s, sent %d, want ready with nothing sent", status, body, len(m.anthropic.requests()))
	}
}

func TestACodexKeyOutOfCreditIsCheckedWithTheFewestOutputTokensTheResponsesAPITakes(t *testing.T) {
	m := aMachine(t)
	m.openai.answer = func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			_, _ = io.WriteString(w, `{"data":[{"id":"gpt-6"},{"id":"gpt-6-mini"},{"id":"gpt-6-nano"}]}`)
			return
		}
		_, _ = io.WriteString(w, `{}`)
	}
	if err := m.states.Record("codex", keys.OutOfCredit, monday); err != nil {
		t.Fatal(err)
	}

	status, _, body := m.call(t, "POST", "/aeolus/check/codex", nil, "")

	sent := m.openai.requests()
	var check struct {
		Model           string `json:"model"`
		MaxOutputTokens int    `json:"max_output_tokens"`
	}
	if status != 200 || body != `{"state":"ready"}` || len(sent) != 2 || sent[1].Path != "/v1/responses" || json.Unmarshal([]byte(sent[1].Body), &check) != nil || check.Model != "gpt-6-nano" || check.MaxOutputTokens != 16 {
		t.Fatalf("answer = %d %s, sent %+v, want ready after 16 tokens on gpt-6-nano", status, body, sent)
	}
}
