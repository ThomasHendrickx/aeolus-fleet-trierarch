package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/container"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/sessions"
)

// guardCheckOver is the answer of the ship's socket, as shipSockets opens it on the runtime, to a guard check of a ship not crewed here.
func guardCheckOver(t *testing.T, running runningSessions) (int, string) {
	t.Helper()
	longTemp := filepath.Join(t.TempDir(), strings.Repeat("x", 108))
	if err := os.Mkdir(longTemp, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", longTemp)

	// Use /tmp directly so the full socket path fits in the macOS Unix address.
	home, err := os.MkdirTemp("/tmp", "s")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	at := paths.Of(home, "")
	sockets := shipSockets(at, "http://127.0.0.1:1", running)
	t.Cleanup(sockets.CloseAll)
	socket, err := sockets.Open("shp_01m6jyczpnpp5c0vxh54c966cy", "")
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}}
	response, err := client.Post("http://ship/guard/check", "application/json", strings.NewReader(`{"tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"/"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	return response.StatusCode, strings.TrimSpace(string(body))
}

func TestTheShipSocketsOfContainerSessionsAnswerTheirGuardCheckOnTheHost(t *testing.T) {
	status, body := guardCheckOver(t, container.Runtime{})

	if want := "Refused by the guard: guard failed: ship not crewed here."; status != http.StatusForbidden || body != want {
		t.Fatalf("guard check = %d %q, want 403 %q, checked against the state", status, body, want)
	}
}

func TestTheShipSocketsOfHostSessionsHaveNoGuardCheck(t *testing.T) {
	status, body := guardCheckOver(t, sessions.Runtime{})

	if want := "Refused by the guard: guard failed: no guard."; status != http.StatusForbidden || body != want {
		t.Fatalf("guard check = %d %q, want 403 %q: a host session runs guard check itself", status, body, want)
	}
}
