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
	"time"
)

// Socket is the private channel in the proxy's folder, never mounted into sessions.
const Socket = "permissions.sock"
const ownerTimeout = 10 * time.Second

var shipPattern = regexp.MustCompile(`^shp_[0-7][0-9a-hjkmnp-tv-z]{25}$`)

// Listen serves owner reads in the trierarch. Authorization is bound to a running
// session and its permission server; the proxy never receives a crew token.
func Listen(path string, authorized func(string, string) bool, owners OwnerReader) (io.Closer, error) {
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
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ship := strings.TrimPrefix(r.URL.Path, "/")
		token, hasBearer := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if r.Method != http.MethodGet || !hasBearer || !authorized(ship, token) {
			http.Error(w, "not a running permission session", http.StatusForbidden)
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
	go func() { _ = server.Serve(listener) }()
	return server, nil
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
	URL     string
	TokenOf func(string) string
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
