// Package shipsocket is the socket of each ship the trierarch crews
// (decision 0026): a session holds no fleet credential, so its fleet calls
// come over a Unix socket of its ship's own, `<root>/<ship id>/fleet.sock`,
// in a folder only the trierarch's user opens. The trierarch adds the ship's
// crew token, read at each call so a new crew reaches the same socket, and
// forwards the call unchanged; the fleet's answer goes back unchanged, a 503
// included. It answers only a caller the caller check allows, and checks
// only the path (the ship API and the ship protocol, never register or
// deregister) and the size, and logs one line per call without the body. It
// queues nothing: when the fleet gives no answer, the session gets none
// either.
package shipsocket

import (
	"bytes"
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

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/peer"
)

// MaxBytes is the most a call's body may hold: a 256 KB payload with the JSON around it (aeolus-fleet decision 0006).
const MaxBytes = 320 * 1024

const socketFile = "fleet.sock"

// protocol is the ship protocol, which a session reads at each start (`aeolus-fleet.sh protocol`).
const protocol = "/api/v1/openapi.json"

// shipCall is one word under the ship API: `/api/v1/ship/send`.
var shipCall = regexp.MustCompile(`^/api/v1/ship/([A-Za-z]+)$`)

// crewCalls make or end a crew: only the trierarch makes them, never a session.
var crewCalls = map[string]bool{"register": true, "deregister": true}

// fleetTimeout is the longest a forwarded call waits for the fleet; a push receive waits about 25 seconds when nothing is there.
const fleetTimeout = 2 * time.Minute

type Options struct {
	Root     string
	FleetURL string
	// CrewTokenOf is the ship's crew token as the state holds it now.
	CrewTokenOf func(shipID string) string
	// MayCall is whether the process at the other end of a connection may call the ship's socket.
	MayCall func(shipID string, pid int) bool
	Log     func(line string)
}

type open struct {
	server   *http.Server
	listener net.Listener
	path     string
}

// Sockets are the ships' sockets this trierarch has open.
type Sockets struct {
	options Options
	client  *http.Client
	mutex   sync.Mutex
	servers map[string]open
}

func New(options Options) *Sockets {
	return &Sockets{options: options, client: &http.Client{Timeout: fleetTimeout}, servers: map[string]open{}}
}

type connectionKey struct{}

// Open opens the ship's socket, or keeps the one open; answers its path.
func (s *Sockets) Open(shipID string) (string, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if opened, ok := s.servers[shipID]; ok {
		return opened.path, nil
	}
	folder := filepath.Join(s.options.Root, shipID)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(folder, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(folder, socketFile)
	// A socket file left by a trierarch that stopped: nothing listens on it any more.
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return "", fmt.Errorf("open the socket of %s: %w", shipID, err)
	}
	server := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.handle(shipID, w, r) }),
		ConnContext: func(ctx context.Context, connection net.Conn) context.Context {
			return context.WithValue(ctx, connectionKey{}, connection)
		},
	}
	go func() { _ = server.Serve(listener) }()
	s.servers[shipID] = open{server: server, listener: listener, path: path}
	return path, nil
}

// Close closes the ship's socket and removes its file: a call then gets no answer.
func (s *Sockets) Close(shipID string) {
	s.mutex.Lock()
	opened, ok := s.servers[shipID]
	delete(s.servers, shipID)
	s.mutex.Unlock()
	if ok {
		_ = opened.server.Close()
	}
	_ = os.Remove(filepath.Join(s.options.Root, shipID, socketFile))
}

// CloseAll closes every socket open.
func (s *Sockets) CloseAll() {
	s.mutex.Lock()
	shipIDs := make([]string, 0, len(s.servers))
	for shipID := range s.servers {
		shipIDs = append(shipIDs, shipID)
	}
	s.mutex.Unlock()
	for _, shipID := range shipIDs {
		s.Close(shipID)
	}
}

// isForwarded is whether the socket forwards a call to this path: the ship API but crewing, and the protocol.
func isForwarded(method string, path string) bool {
	if method == http.MethodGet && path == protocol {
		return true
	}
	match := shipCall.FindStringSubmatch(path)
	return match != nil && !crewCalls[match[1]]
}

// refusalCodes are the code a refusal of each status says, as the fleet's refusals do.
var refusalCodes = map[int]string{http.StatusForbidden: "FORBIDDEN", http.StatusRequestEntityTooLarge: "PAYLOAD_TOO_LARGE"}

func refuse(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Connection", "close")
	w.WriteHeader(status)
	text, _ := json.Marshal(map[string]string{"code": refusalCodes[status], "message": message})
	_, _ = w.Write(text)
}

func (s *Sockets) handle(shipID string, w http.ResponseWriter, r *http.Request) {
	path := r.URL.RequestURI()
	said := func(outcome string) {
		s.options.Log(fmt.Sprintf("fleet call %s %s %s %s", shipID, r.Method, path, outcome))
	}
	connection, _ := r.Context().Value(connectionKey{}).(net.Conn)
	if connection == nil || !s.options.MayCall(shipID, peer.PID(connection)) {
		refuse(w, http.StatusForbidden, "This socket answers only its ship's own session")
		said("403")
		return
	}
	if !isForwarded(r.Method, r.URL.Path) {
		refuse(w, http.StatusForbidden, "This socket forwards only ship calls, never register or deregister")
		said("403")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxBytes+1))
	if err != nil {
		said("no body")
		return
	}
	if len(body) > MaxBytes {
		refuse(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("A call is at most %d bytes", MaxBytes))
		said("413")
		return
	}
	var forwarded io.Reader
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		forwarded = bytes.NewReader(body)
	}
	call, err := http.NewRequestWithContext(r.Context(), r.Method, strings.TrimSuffix(s.options.FleetURL, "/")+path, forwarded)
	if err != nil {
		refuse(w, http.StatusForbidden, err.Error())
		said("403")
		return
	}
	if crewToken := s.options.CrewTokenOf(shipID); crewToken != "" {
		call.Header.Set("Authorization", "Bearer "+crewToken)
	}
	if contentType := r.Header.Get("Content-Type"); contentType != "" {
		call.Header.Set("Content-Type", contentType)
	}
	answer, err := s.client.Do(call)
	if err != nil {
		// No answer from the fleet: none for the session either, as when it calls a fleet that is down.
		if hijacker, ok := w.(http.Hijacker); ok {
			if raw, _, err := hijacker.Hijack(); err == nil {
				_ = raw.Close()
			}
		}
		said("no answer")
		return
	}
	defer answer.Body.Close()
	answered, err := io.ReadAll(answer.Body)
	if err != nil {
		said("no answer")
		return
	}
	if contentType := answer.Header.Get("Content-Type"); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.WriteHeader(answer.StatusCode)
	_, _ = w.Write(answered)
	said(fmt.Sprint(answer.StatusCode))
}
