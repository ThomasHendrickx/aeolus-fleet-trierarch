package shipsocket

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const scout = "shp_01m6jyczpnpp5c0vxh54c966cy"

// aFleet is a stand-in fleet that answers each call with the status, type and body given, and keeps what it was called with.
type aFleet struct {
	server *httptest.Server
	mutex  sync.Mutex
	calls  []call
}

type call struct {
	method, path, authorization, contentType, body string
}

func aFleetAnswering(t *testing.T, status int, contentType string, body string) *aFleet {
	t.Helper()
	fleet := &aFleet{}
	fleet.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ := io.ReadAll(r.Body)
		fleet.mutex.Lock()
		fleet.calls = append(fleet.calls, call{r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Content-Type"), string(got)})
		fleet.mutex.Unlock()
		w.Header().Set("Content-Type", contentType)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(fleet.server.Close)
	return fleet
}

func (f *aFleet) called() []call {
	f.mutex.Lock()
	defer f.mutex.Unlock()
	return append([]call{}, f.calls...)
}

// someSockets are the sockets of a root of their own for the fleet at the URL, the crew token the one given, every caller allowed unless refused.
func someSockets(t *testing.T, fleetURL string, crewToken *string, isRefused bool) *Sockets {
	t.Helper()
	root, err := os.MkdirTemp("", "sockets")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	sockets := New(Options{
		Root:        root,
		FleetURL:    fleetURL,
		CrewTokenOf: func(string) string { return *crewToken },
		MayCall:     func(string, int) bool { return !isRefused },
		Log:         func(string) {},
	})
	t.Cleanup(sockets.CloseAll)
	return sockets
}

// over is an HTTP client that calls the Unix socket at the path, whatever the URL's host.
func over(socket string) *http.Client {
	return &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}}
}

func opened(t *testing.T, sockets *Sockets) string {
	t.Helper()
	path, err := sockets.Open(scout)
	if err != nil {
		t.Fatalf("Open(%s): %v", scout, err)
	}
	return path
}

func post(t *testing.T, socket string, path string, body string) (*http.Response, string) {
	t.Helper()
	response, err := over(socket).Post("http://ship"+path, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer response.Body.Close()
	got, _ := io.ReadAll(response.Body)
	return response, string(got)
}

func TestAShipCallGoesToTheFleetWithTheShipsCrewTokenAndItsAnswerComesBackUnchanged(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{"deliveries":[]}`)
	token := "aeolus_ct_v1_scout"
	socket := opened(t, someSockets(t, fleet.server.URL, &token, false))

	response, body := post(t, socket, "/api/v1/ship/receive", `{"max":1}`)

	if response.StatusCode != 200 || body != `{"deliveries":[]}` || response.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("answer = %d %s %q, want the fleet's 200 application/json and body", response.StatusCode, response.Header.Get("Content-Type"), body)
	}
	want := call{"POST", "/api/v1/ship/receive", "Bearer aeolus_ct_v1_scout", "application/json", `{"max":1}`}
	if got := fleet.called(); len(got) != 1 || got[0] != want {
		t.Fatalf("the fleet was called with %+v, want %+v", got, want)
	}
}

func TestARefusalOfTheFleetComesBackUnchanged(t *testing.T) {
	fleet := aFleetAnswering(t, 503, "application/json", `{"code":"SERVICE_UNAVAILABLE","message":"busy"}`)
	token := "aeolus_ct_v1_scout"
	socket := opened(t, someSockets(t, fleet.server.URL, &token, false))

	response, body := post(t, socket, "/api/v1/ship/send", `{}`)

	if response.StatusCode != 503 || body != `{"code":"SERVICE_UNAVAILABLE","message":"busy"}` {
		t.Fatalf("answer = %d %q, want the fleet's 503 unchanged", response.StatusCode, body)
	}
}

func TestEachCallTakesTheCrewTokenOfTheShipAsItIsThen(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{}`)
	token := "aeolus_ct_v1_first"
	socket := opened(t, someSockets(t, fleet.server.URL, &token, false))
	post(t, socket, "/api/v1/ship/inbox", `{}`)

	token = "aeolus_ct_v1_second"
	post(t, socket, "/api/v1/ship/inbox", `{}`)

	if got := fleet.called(); len(got) != 2 || got[1].authorization != "Bearer aeolus_ct_v1_second" {
		t.Fatalf("the second call = %+v, want the new crew token", got)
	}
}

func TestTheShipProtocolIsForwarded(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{"openapi":"3.1.0"}`)
	token := "aeolus_ct_v1_scout"
	socket := opened(t, someSockets(t, fleet.server.URL, &token, false))

	response, err := over(socket).Get("http://ship/api/v1/openapi.json")

	if err != nil || response.StatusCode != 200 {
		t.Fatalf("GET /api/v1/openapi.json = %v %v, want 200", response, err)
	}
	if got := fleet.called(); len(got) != 1 || got[0].method != "GET" || got[0].path != "/api/v1/openapi.json" {
		t.Fatalf("the fleet was called with %+v, want the protocol", got)
	}
}

func TestAFleetCallGoesToTheFleetWithTheShipsCrewToken(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{"shipId":"shp_1"}`)
	token := "aeolus_ct_v1_scout"
	socket := opened(t, someSockets(t, fleet.server.URL, &token, false))

	response, body := post(t, socket, "/api/v1/fleet/commission", `{"name":"scout"}`)

	if response.StatusCode != 200 || body != `{"shipId":"shp_1"}` {
		t.Fatalf("answer = %d %q, want the fleet's 200 and body", response.StatusCode, body)
	}
	want := call{"POST", "/api/v1/fleet/commission", "Bearer aeolus_ct_v1_scout", "application/json", `{"name":"scout"}`}
	if got := fleet.called(); len(got) != 1 || got[0] != want {
		t.Fatalf("the fleet was called with %+v, want %+v", got, want)
	}
}

func TestTheFleetsForbiddenForAMissingScopeComesBackUnchanged(t *testing.T) {
	refusal := `{"code":"FORBIDDEN","message":"This ship lacks the scope fleet:commission"}`
	fleet := aFleetAnswering(t, 403, "application/json", refusal)
	token := "aeolus_ct_v1_scout"
	socket := opened(t, someSockets(t, fleet.server.URL, &token, false))

	response, body := post(t, socket, "/api/v1/fleet/commission", `{}`)

	if response.StatusCode != 403 || body != refusal || response.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("answer = %d %s %q, want the fleet's 403 unchanged", response.StatusCode, response.Header.Get("Content-Type"), body)
	}
	if got := fleet.called(); len(got) != 1 {
		t.Fatalf("the fleet was called %d times, want once", len(got))
	}
}

func TestOnlyShipAndFleetCallsGoToTheFleetNeverRegisterOrDeregister(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{}`)
	token := "aeolus_ct_v1_scout"
	socket := opened(t, someSockets(t, fleet.server.URL, &token, false))

	for _, path := range []string{
		"/api/v1/ship/register", "/api/v1/ship/deregister", "/api/v1/fleet/register", "/api/v1/fleet/deregister",
		"/api/v1/console/list", "/api/v1/ship/a/b", "/api/v1/fleet/ship/release", "/mcp", "/trpc/ship.send", "/trpc/fleet.commission",
		"/api/v1/ship/../../trpc/ship.send", "/api/v1/fleet/../ship/register",
	} {
		t.Run(path, func(t *testing.T) {
			response, body := post(t, socket, path, `{}`)

			if response.StatusCode != 403 || !strings.Contains(body, `"code":"FORBIDDEN"`) {
				t.Fatalf("POST %s = %d %s, want 403 FORBIDDEN", path, response.StatusCode, body)
			}
		})
	}
	if got := fleet.called(); len(got) != 0 {
		t.Fatalf("the fleet was called with %+v, want none", got)
	}
}

func TestACallOverTheBoundIsRefusedAndTheExactBoundIsForwarded(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{}`)
	token := "aeolus_ct_v1_scout"
	socket := opened(t, someSockets(t, fleet.server.URL, &token, false))

	atBound, _ := post(t, socket, "/api/v1/ship/send", string(bytes.Repeat([]byte("a"), 320*1024)))
	overBound, body := post(t, socket, "/api/v1/ship/send", string(bytes.Repeat([]byte("a"), 320*1024+1)))

	if atBound.StatusCode != 200 {
		t.Fatalf("a call of exactly 320 KiB = %d, want 200", atBound.StatusCode)
	}
	if overBound.StatusCode != 413 || !strings.Contains(body, `"code":"PAYLOAD_TOO_LARGE"`) {
		t.Fatalf("a call one byte over = %d %s, want 413 PAYLOAD_TOO_LARGE", overBound.StatusCode, body)
	}
	if got := fleet.called(); len(got) != 1 {
		t.Fatalf("the fleet was called %d times, want once", len(got))
	}
}

func TestAFleetCallOverTheBoundIsRefusedAndTheExactBoundIsForwarded(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{}`)
	token := "aeolus_ct_v1_scout"
	socket := opened(t, someSockets(t, fleet.server.URL, &token, false))

	atBound, _ := post(t, socket, "/api/v1/fleet/commission", string(bytes.Repeat([]byte("a"), 320*1024)))
	overBound, body := post(t, socket, "/api/v1/fleet/commission", string(bytes.Repeat([]byte("a"), 320*1024+1)))

	if atBound.StatusCode != 200 {
		t.Fatalf("a fleet call of exactly 320 KiB = %d, want 200", atBound.StatusCode)
	}
	if overBound.StatusCode != 413 || !strings.Contains(body, `"code":"PAYLOAD_TOO_LARGE"`) {
		t.Fatalf("a fleet call one byte over = %d %s, want 413 PAYLOAD_TOO_LARGE", overBound.StatusCode, body)
	}
	if got := fleet.called(); len(got) != 1 {
		t.Fatalf("the fleet was called %d times, want once", len(got))
	}
}

func TestACallerTheSocketMayNotAnswerIsRefusedAFleetCallToo(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{}`)
	token := "aeolus_ct_v1_scout"
	socket := opened(t, someSockets(t, fleet.server.URL, &token, true))

	response, body := post(t, socket, "/api/v1/fleet/commission", `{}`)

	if response.StatusCode != 403 || !strings.Contains(body, "only its ship's own session") {
		t.Fatalf("answer = %d %s, want 403 for a caller of another session", response.StatusCode, body)
	}
	if got := fleet.called(); len(got) != 0 {
		t.Fatalf("the fleet was called with %+v, want none", got)
	}
}

func TestACallerTheSocketMayNotAnswerIsRefused(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{}`)
	token := "aeolus_ct_v1_scout"
	socket := opened(t, someSockets(t, fleet.server.URL, &token, true))

	response, body := post(t, socket, "/api/v1/ship/receive", `{}`)

	if response.StatusCode != 403 || !strings.Contains(body, "only its ship's own session") {
		t.Fatalf("answer = %d %s, want 403 for a caller of another session", response.StatusCode, body)
	}
	if got := fleet.called(); len(got) != 0 {
		t.Fatalf("the fleet was called with %+v, want none", got)
	}
}

func TestWhenTheFleetGivesNoAnswerTheSessionGetsNone(t *testing.T) {
	token := "aeolus_ct_v1_scout"
	socket := opened(t, someSockets(t, "http://127.0.0.1:1", &token, false))

	response, err := over(socket).Post("http://ship/api/v1/ship/receive", "application/json", strings.NewReader(`{}`))

	if err == nil {
		t.Fatalf("answer = %d, want none", response.StatusCode)
	}
}

func TestTheSocketIsInAFolderOnlyItsUserOpens(t *testing.T) {
	token := "aeolus_ct_v1_scout"
	socket := opened(t, someSockets(t, "http://127.0.0.1:1", &token, false))

	folder, err := os.Stat(strings.TrimSuffix(socket, "/fleet.sock"))

	if err != nil || folder.Mode().Perm() != 0o700 || !strings.HasSuffix(socket, "/"+scout+"/fleet.sock") {
		t.Fatalf("socket %s in a folder of mode %v (%v), want <root>/%s/fleet.sock in a folder of 0700", socket, folder.Mode().Perm(), err, scout)
	}
}

func TestAClosedSocketAnswersNoMoreAndItsFileIsGone(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{}`)
	token := "aeolus_ct_v1_scout"
	sockets := someSockets(t, fleet.server.URL, &token, false)
	socket := opened(t, sockets)

	sockets.Close(scout)

	if _, err := os.Stat(socket); err == nil {
		t.Fatalf("%s is still there", socket)
	}
	if _, err := over(socket).Post("http://ship/api/v1/ship/inbox", "application/json", strings.NewReader(`{}`)); err == nil {
		t.Fatalf("a closed socket answered")
	}
}

func TestASocketLeftByATrierarchThatStoppedIsOpenedAgain(t *testing.T) {
	fleet := aFleetAnswering(t, 200, "application/json", `{}`)
	root, err := os.MkdirTemp("", "sockets")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	left := filepath.Join(root, scout, "fleet.sock")
	_ = os.MkdirAll(filepath.Dir(left), 0o700)
	stale, err := net.ListenUnix("unix", &net.UnixAddr{Name: left, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	stale.SetUnlinkOnClose(false)
	_ = stale.Close()
	sockets := New(Options{Root: root, FleetURL: fleet.server.URL, CrewTokenOf: func(string) string { return "aeolus_ct_v1_scout" }, MayCall: func(string, int) bool { return true }, Log: func(string) {}})
	t.Cleanup(sockets.CloseAll)

	socket := opened(t, sockets)

	if socket != left {
		t.Fatalf("Open = %s, want %s", socket, left)
	}
	if response, _ := post(t, socket, "/api/v1/ship/inbox", `{}`); response.StatusCode != 200 {
		t.Fatalf("answer = %d, want 200", response.StatusCode)
	}
}

func TestOpeningAnOpenSocketKeepsIt(t *testing.T) {
	token := "aeolus_ct_v1_scout"
	sockets := someSockets(t, "http://127.0.0.1:1", &token, false)
	first := opened(t, sockets)

	second := opened(t, sockets)

	if first != second {
		t.Fatalf("Open again = %s, want %s", second, first)
	}
}

func TestAnAnswerThatEndsBeforeItsContentLengthGivesTheShipNoCompleteAnswer(t *testing.T) {
	fleet := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		_, _ = connection.Write([]byte("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"id\":"))
		_ = connection.Close()
	}))
	t.Cleanup(fleet.Close)
	token := "aeolus_ct_v1_scout"
	socket := opened(t, someSockets(t, fleet.URL, &token, false))

	response, err := over(socket).Post("http://ship/api/v1/ship/send", "application/json", strings.NewReader(`{}`))
	if err == nil {
		_, err = io.ReadAll(response.Body)
		_ = response.Body.Close()
	}

	if err == nil {
		t.Fatal("the ship got a whole answer, want an error or a closed connection")
	}
}

func TestACallBodyThatEndsBeforeItsContentLengthIsAnsweredNoSuccess(t *testing.T) {
	fleet := aFleetAnswering(t, http.StatusOK, "application/json", `{}`)
	token := "aeolus_ct_v1_scout"
	socket := opened(t, someSockets(t, fleet.server.URL, &token, false))
	connection, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))

	_, _ = connection.Write([]byte("POST /api/v1/ship/send HTTP/1.1\r\nHost: ship\r\nContent-Length: 50\r\n\r\n{\"payload\":"))
	_ = connection.(*net.UnixConn).CloseWrite()
	answered, _ := io.ReadAll(connection)

	if strings.HasPrefix(string(answered), "HTTP/1.1 2") {
		t.Fatalf("the ship got %q, want no success", answered)
	}
	if got := fleet.called(); len(got) != 0 {
		t.Fatalf("the fleet was called with %+v, want none", got)
	}
}

func TestAStreamedAnswerReachesTheShipAsItArrivesAndHasNoWholeCallTimeout(t *testing.T) {
	release := make(chan struct{})
	fleet := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("event: wake\ndata: {}\n\n"))
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = w.Write([]byte("event: end\ndata: {}\n\n"))
	}))
	t.Cleanup(fleet.Close)
	token := "aeolus_ct_v1_scout"
	sockets := someSockets(t, fleet.URL, &token, false)
	if sockets.client.Timeout != 0 {
		t.Fatalf("the fleet client waits %v for a whole call, want no timeout", sockets.client.Timeout)
	}
	socket := opened(t, sockets)
	client := over(socket)
	client.Timeout = 0

	response, err := client.Get("http://ship/api/v1/ship/wakeups")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	first := make(chan string, 1)
	go func() {
		line, _ := reader.ReadString('\n')
		first <- line
	}()

	select {
	case line := <-first:
		if line != "event: wake\n" {
			t.Fatalf("first line = %q, want the wake event", line)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the first event did not arrive while the stream was open")
	}
	close(release)
	rest, err := io.ReadAll(reader)
	if err != nil || !strings.Contains(string(rest), "event: end") {
		t.Fatalf("rest = %q, err = %v, want the end event after the stream stayed open", rest, err)
	}
}
