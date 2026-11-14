package permissions

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

type owners struct {
	person bool
	err    error
	reads  int
}

func (o *owners) Owner(context.Context, string) (Owner, error) {
	o.reads++
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
	if o.reads != 3 {
		t.Fatalf("owner reads = %d, want 3", o.reads)
	}
}
func TestThePrivateChannelRefusesAnotherShipsTokenAndFailsClosedWhenDown(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "p.sock")
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
	if o.reads != 1 {
		t.Fatalf("reads = %d, want authorized ship alone", o.reads)
	}
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	if got := Deny(context.Background(), "scout", client); got.Message != "could not read this ship's owner: nobody is asked" {
		t.Fatalf("down = %+v", got)
	}
}
