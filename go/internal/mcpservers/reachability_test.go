package mcpservers

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"
)

func TestReachabilityAcceptsAnyHTTPAnswerWithoutFollowingRedirects(t *testing.T) {
	for _, status := range []int{200, 401, 404, 405, 500, 302} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/mcp" {
					t.Errorf("path = %s, want /mcp", r.URL.Path)
				}
				w.Header().Set("Location", "http://unreachable.invalid/")
				w.WriteHeader(status)
			}))
			defer server.Close()
			got, problems := (Checker{}).Check(context.Background(), []Server{{Name: "graph", URL: server.URL + "/mcp"}})
			if len(got) != 1 || len(problems) != 0 {
				t.Errorf("Check = %v, %v, want graph reachable", got, problems)
			}
		})
	}
}

func TestReachabilityLeavesOutRefusedConnectionsAndOffersThemAfterRecovery(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(401) }))
	address := server.Listener.Addr().String()
	server.Listener.Close()
	list := []Server{{Name: "graph", URL: "http://" + address + "/mcp"}}
	checker := Checker{}
	got, problems := checker.Check(context.Background(), list)
	if len(got) != 0 || problems["graph"] != "connection refused" {
		t.Fatalf("Check = %v, %v, want graph refused", got, problems)
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	server.Listener = listener
	server.Start()
	defer server.Close()
	got, problems = checker.Check(context.Background(), list)
	offered := OfferedBy(got, []string{"claude-code", "codex", "copilot"}, map[string]func(string) bool{"claude-code": everyServer, "codex": everyServer, "copilot": everyServer})
	for harness, names := range offered {
		if !slices.Equal(names, []string{"graph"}) || len(problems) != 0 {
			t.Errorf("%s offers %v, problems %v, want graph", harness, names, problems)
		}
	}
}

func TestReachabilityLeavesOutDNSFailuresWithoutAnOutsideLookup(t *testing.T) {
	transport := &http.Transport{DialContext: func(context.Context, string, string) (net.Conn, error) {
		return nil, &net.DNSError{Err: "no such host", Name: "graph.invalid", IsNotFound: true}
	}}
	defer transport.CloseIdleConnections()
	got, problems := (Checker{Client: &http.Client{Transport: transport}}).Check(context.Background(), []Server{{Name: "graph", URL: "http://graph.invalid/mcp"}})
	if len(got) != 0 || problems["graph"] != "DNS lookup failed" {
		t.Errorf("Check = %v, %v, want graph DNS failure", got, problems)
	}
}

func TestReachabilityBoundsARequestThatDoesNotAnswer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	started := time.Now()
	got, problems := (Checker{}).Check(context.Background(), []Server{{Name: "graph", URL: server.URL}})
	if len(got) != 0 || problems["graph"] != "request timed out" || time.Since(started) > 3*time.Second {
		t.Errorf("Check = %v, %v after %v, want timeout within 3s", got, problems, time.Since(started))
	}
}
