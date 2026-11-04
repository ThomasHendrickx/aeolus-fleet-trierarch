package keys

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func aVendor(t *testing.T, status int, body string, seen *http.Header) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			w.WriteHeader(404)
			return
		}
		*seen = r.Header.Clone()
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func TestAKeyItsVendorListsItsModelsForIsTaken(t *testing.T) {
	var seen http.Header
	vendor := aVendor(t, 200, `{"data":[]}`, &seen)

	got := Check("claude-code", key, vendor)

	if !got.IsTaken || seen.Get("x-api-key") != key || seen.Get("anthropic-version") != "2023-06-01" {
		t.Fatalf("Check = %+v, sent %v, want taken with the key as x-api-key", got, seen)
	}
}

func TestOpenAIIsSentTheKeyAsItsBearer(t *testing.T) {
	var seen http.Header
	vendor := aVendor(t, 200, `{"data":[]}`, &seen)

	if got := Check("codex", "sk-proj-a-key", vendor); !got.IsTaken || seen.Get("authorization") != "Bearer sk-proj-a-key" {
		t.Fatalf("Check = %+v, sent %v", got, seen)
	}
}

func TestARefusalNamesTheVendorsStatusAndErrorCodeNeverItsMessage(t *testing.T) {
	var seen http.Header
	vendor := aVendor(t, 401, `{"error":{"type":"invalid_request_error","code":"invalid_api_key","message":"Incorrect API key provided: sk-proj-****key"}}`, &seen)

	got := Check("codex", "sk-proj-a-key", vendor)

	if got.IsTaken || got.Cause != "OpenAI refused the key: 401 invalid_api_key" {
		t.Fatalf("Check = %+v", got)
	}
}

func TestAKeyThatCannotBeAHeaderIsRefusedBeforeAnythingIsSent(t *testing.T) {
	var seen http.Header
	vendor := aVendor(t, 200, `{"data":[]}`, &seen)

	got := Check("claude-code", "sk-ant two words", vendor)

	if got.IsTaken || !strings.HasPrefix(got.Cause, "The key holds a character no API key holds") || seen != nil {
		t.Fatalf("Check = %+v, sent %v", got, seen)
	}
}

func TestAVendorThatCannotBeReachedIsSaid(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	server.Close()

	got := Check("claude-code", key, server.URL)

	if got.IsTaken || !strings.HasPrefix(got.Cause, "Anthropic could not be reached at "+server.URL) || strings.Contains(got.Cause, key) {
		t.Fatalf("Check = %+v", got)
	}
}
