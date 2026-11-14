package permissions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Socket is the private channel in the proxy's folder, never mounted into sessions.
const Socket = "permissions.sock"
const ownerTimeout = 10 * time.Second

var shipPattern = regexp.MustCompile(`^shp_[0-7][0-9a-hjkmnp-tv-z]{25}$`)

// Listen serves owner reads in the trierarch. Authorization is bound to a running
// session and its permission server; the proxy never receives a crew token.
func Listen(path string, authorized func(string, string) bool, owners OwnerReader) (*Channel, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = listener.Close()
		return nil, err
	}
	channel := &Channel{calls: make(map[*channelCall]bool)}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		channel.mu.Lock()
		if channel.isClosed {
			channel.mu.Unlock()
			http.Error(w, "permission channel closing", http.StatusServiceUnavailable)
			return
		}
		channel.wait.Add(1)
		channel.mu.Unlock()
		defer channel.wait.Done()
		ship := strings.TrimPrefix(r.URL.Path, "/")
		token, hasBearer := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if (r.Method != http.MethodGet && r.Method != http.MethodPost) || !hasBearer || !authorized(ship, token) {
			http.Error(w, "not a running permission session", http.StatusForbidden)
			return
		}
		if r.Method == http.MethodPost {
			var input Request
			if json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&input) != nil {
				http.Error(w, "invalid permission wait", http.StatusBadRequest)
				return
			}
			waiter, ok := owners.(interface {
				Ask(context.Context, string, Request) Decision
			})
			if !ok {
				http.Error(w, "permission wait unavailable", http.StatusServiceUnavailable)
				return
			}
			ctx, cancel := context.WithCancel(r.Context())
			defer cancel()
			name := input.UseID
			if name == "" {
				name = input.Tool
			}
			if name == "" {
				name = "permission call"
			}
			call := &channelCall{ship: ship, name: name, cancel: cancel, done: make(chan struct{})}
			channel.mu.Lock()
			// Draining follows session stop. Recheck under the registry lock so a
			// request that was still reading its input cannot start after the drain.
			if !authorized(ship, token) {
				channel.mu.Unlock()
				http.Error(w, "not a running permission session", http.StatusForbidden)
				return
			}
			channel.calls[call] = true
			channel.mu.Unlock()
			defer func() { channel.mu.Lock(); delete(channel.calls, call); close(call.done); channel.mu.Unlock() }()
			decision := waiter.Ask(ctx, ship, input)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(decision)
			return
		}
		owner, err := owners.Owner(r.Context(), ship)
		if err != nil {
			http.Error(w, "owner unreadable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(owner)
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: ownerTimeout}
	channel.server = server
	go func() { _ = server.Serve(listener) }()
	return channel, nil
}

// Channel waits for cancelled handlers to finish their withdrawals before
// the trierarch process can exit.
type Channel struct {
	calls    map[*channelCall]bool
	server   *http.Server
	mu       sync.Mutex
	wait     sync.WaitGroup
	isClosed bool
}

func (c *Channel) Close() error {
	c.mu.Lock()
	c.isClosed = true
	c.mu.Unlock()
	err := c.server.Close()
	c.wait.Wait()
	return err
}

type channelCall struct {
	ship, name string
	cancel     context.CancelFunc
	done       chan struct{}
}

// Drain cancels one stopped ship's calls and waits until withdrawal completes or
// the caller's deadline ends. Unfinished calls are named without tool input.
func (c *Channel) Drain(ctx context.Context, ship string) []string {
	c.mu.Lock()
	var calls []*channelCall
	for call := range c.calls {
		if call.ship == ship {
			calls = append(calls, call)
			call.cancel()
		}
	}
	c.mu.Unlock()
	for _, call := range calls {
		select {
		case <-call.done:
		case <-ctx.Done():
		}
	}
	var unfinished []string
	for _, call := range calls {
		select {
		case <-call.done:
		default:
			unfinished = append(unfinished, call.name)
		}
	}
	return unfinished
}

// Client hands an owner read to the trierarch over the private channel.
type Client struct {
	Socket string
	Token  string
}

// Owner reads through the private channel and propagates cancellation.
func (c Client) Owner(ctx context.Context, ship string) (Owner, error) {
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", c.Socket)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: ownerTimeout}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://trierarch/"+ship, nil)
	if err != nil {
		return Owner{}, err
	}
	request.Header.Set("Authorization", "Bearer "+c.Token)
	answer, err := client.Do(request)
	if err != nil {
		return Owner{}, err
	}
	defer answer.Body.Close()
	if answer.StatusCode != http.StatusOK {
		return Owner{}, fmt.Errorf("owner channel status %d", answer.StatusCode)
	}
	var owner Owner
	err = json.NewDecoder(io.LimitReader(answer.Body, 4096)).Decode(&owner)
	return owner, err
}

// Fleet reads whoami as the ship, inside the trierarch only.
type Fleet struct {
	Questions Questions
	URL       string
	TokenOf   func(string) string
	Clock     Clock
	Log       func(string)
}

// Owner calls whoami with the current crew token and validates its owner.
func (f Fleet) Owner(ctx context.Context, ship string) (Owner, error) {
	if !shipPattern.MatchString(ship) {
		return Owner{}, errors.New("invalid ship")
	}
	token := f.TokenOf(ship)
	if token == "" {
		return Owner{}, errors.New("ship has no crew")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, f.URL+"/api/v1/ship/whoami", nil)
	if err != nil {
		return Owner{}, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: ownerTimeout}
	answer, err := client.Do(request)
	if err != nil {
		return Owner{}, err
	}
	defer answer.Body.Close()
	if answer.StatusCode != http.StatusOK {
		return Owner{}, fmt.Errorf("whoami status %d", answer.StatusCode)
	}
	var fields map[string]json.RawMessage
	if err := json.NewDecoder(io.LimitReader(answer.Body, 4096)).Decode(&fields); err != nil {
		return Owner{}, err
	}
	raw, ok := fields["ownerShipId"]
	if !ok {
		return Owner{}, errors.New("whoami names no owner")
	}
	if string(raw) == "null" {
		return Owner{}, nil
	}
	var id string
	if json.Unmarshal(raw, &id) != nil || !shipPattern.MatchString(id) {
		return Owner{}, errors.New("whoami names an invalid owner")
	}
	var name string
	if json.Unmarshal(fields["ownerName"], &name) != nil || name == "" {
		return Owner{}, errors.New("whoami names an invalid owner")
	}
	return Owner{IsPerson: name != "argo"}, nil
}

// End bounds release cleanup to ten seconds and logs every call still pending.
func (c *Channel) End(ship string, log func(string)) {
	const withdrawalLimit = 10 * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), withdrawalLimit)
	defer cancel()
	for _, call := range c.Drain(ctx, ship) {
		log(fmt.Sprintf("permission withdrawal for %s (%s) did not finish within 10 seconds; release continues", ship, call))
	}
}
