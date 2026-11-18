package mcpservers

import (
	"context"
	"errors"
	"net"
	"net/http"
	"syscall"
	"time"
)

// reachabilityTimeout bounds each probe, including DNS, connection and response headers.
const reachabilityTimeout = 2 * time.Second

// Checker checks the machine's route to MCP servers. The default client uses
// http.DefaultTransport, as the MCP reverse proxy does, and follows no redirects.
// Client may supply another transport for a machine boundary in tests.
type Checker struct {
	Client *http.Client
}

// Check returns servers that answer HTTP and the reason each other server cannot
// be offered. Every invocation probes again, so recovery needs no configuration change.
// No credential is needed: any HTTP answer, including a refusal, proves reachability.
func (c Checker) Check(ctx context.Context, list []Server) ([]Server, map[string]string) {
	client := http.Client{}
	if c.Client != nil {
		client = *c.Client
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	reachable := []Server{}
	problems := map[string]string{}
	for _, server := range list {
		if reason := probe(ctx, &client, server.URL); reason != "" {
			problems[server.Name] = reason
		} else {
			reachable = append(reachable, server)
		}
	}
	return reachable, problems
}

func probe(ctx context.Context, client *http.Client, url string) string {
	ctx, cancel := context.WithTimeout(ctx, reachabilityTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "invalid server URL"
	}
	response, err := client.Do(request)
	if err == nil {
		response.Body.Close()
		return ""
	}
	// Report a cause, never the URL, headers or an error supplied by the server.
	var timeout net.Error
	var dns *net.DNSError
	switch {
	case errors.As(err, &timeout) && timeout.Timeout():
		return "request timed out"
	case errors.As(err, &dns):
		return "DNS lookup failed"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "connection refused"
	case errors.Is(err, context.Canceled):
		return "request canceled"
	default:
		return "HTTP request failed"
	}
}
