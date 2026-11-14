package permissions

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

type owners struct {
	person bool
	err    error
	reads  atomic.Int32
}

func (o *owners) Owner(context.Context, string) (Owner, error) {
	o.reads.Add(1)
	return Owner{IsPerson: o.person}, o.err
}
func TestEveryPermissionCallReadsItsOwnerAndDeniesWithTheReason(t *testing.T) {
	o := &owners{}
	for _, test := range []struct {
		person  bool
		err     error
		message string
	}{
		{false, nil, "this ship's owner is argo: nobody is asked"},
		{true, nil, "permission questions for person-owned ships are not available yet"},
		{false, errors.New("fleet unavailable"), "could not read this ship's owner: nobody is asked"},
	} {
		o.person, o.err = test.person, test.err
		got := Deny(context.Background(), "scout", o)
		if got.Behavior != "deny" || got.Message != test.message {
			t.Fatalf("Deny = %+v, want deny %q", got, test.message)
		}
	}
	if o.reads.Load() != 3 {
		t.Fatalf("owner reads = %d, want 3", o.reads.Load())
	}
}
func TestThePrivateChannelRefusesAnotherShipsTokenAndFailsClosedWhenDown(t *testing.T) {
	folder, err := os.MkdirTemp("", "permissions-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(folder) })
	socket := filepath.Join(folder, "p.sock")
	o := &owners{}
	server, err := Listen(socket, func(ship, token string) bool { return ship == "scout" && token == "session-token" }, o)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	client := Client{Socket: socket, Token: "session-token"}
	if got := Deny(context.Background(), "scout", client); got.Message != "this ship's owner is argo: nobody is asked" {
		t.Fatalf("denial = %+v", got)
	}
	if got := Deny(context.Background(), "builder", client); got.Message != "could not read this ship's owner: nobody is asked" {
		t.Fatalf("other ship = %+v", got)
	}
	if o.reads.Load() != 1 {
		t.Fatalf("reads = %d, want authorized ship alone", o.reads.Load())
	}
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	if got := Deny(context.Background(), "scout", client); got.Message != "could not read this ship's owner: nobody is asked" {
		t.Fatalf("down = %+v", got)
	}
}

func TestWhoamiIsReadAsTheShipAndUnreadableOwnersFailClosed(t *testing.T) {
	for _, test := range []struct {
		name, body     string
		status         int
		person, failed bool
	}{
		{"argo", `{"ownerShipId":null}`, 200, false, false},
		{"person", `{"ownerShipId":"shp_01m6jyczpnpp5c0vxh54c966cz"}`, 200, true, false},
		{"missing owner", `{}`, 200, false, true},
		{"invalid owner", `{"ownerShipId":"not-a-ship"}`, 200, false, true},
		{"malformed", `{`, 200, false, true},
		{"refused", `{}`, 403, false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var correct atomic.Bool
			fleet := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				correct.Store(r.Method == "GET" && r.URL.Path == "/api/v1/ship/whoami" && r.Header.Get("Authorization") == "Bearer test-crew")
				w.WriteHeader(test.status)
				fmt.Fprint(w, test.body)
			}))
			defer fleet.Close()
			reader := Fleet{URL: fleet.URL, TokenOf: func(string) string { return "test-crew" }}
			owner, err := reader.Owner(context.Background(), "shp_01m6jyczpnpp5c0vxh54c966cy")
			if !correct.Load() || (err != nil) != test.failed || owner.IsPerson != test.person {
				t.Fatalf("Owner = %+v, %v, correct request %v", owner, err, correct.Load())
			}
		})
	}
}
