package main

import (
	"errors"
	"testing"
)

type pastaProfileStub struct {
	missing bool
	err     error
}

func (p pastaProfileStub) PastaAppArmor(string, string) (bool, error) { return p.missing, p.err }

type pastaFleetStub struct {
	owner, name              string
	calls                    int
	fail                     bool
	recipient, textName, key string
}

func (p *pastaFleetStub) OwnerOf(string) (string, error) { return p.owner, nil }
func (p *pastaFleetStub) Name() (string, error)          { return p.name, nil }
func (p *pastaFleetStub) TellPastaAppArmor(owner, name, key string) error {
	p.calls++
	p.recipient, p.textName, p.key = owner, name, key
	if p.fail {
		return errors.New("unreachable")
	}
	return nil
}
func TestPastaCheckUsesTheMachinePort(t *testing.T) {
	got, err := checkPastaAppArmor(pastaProfileStub{missing: true}, "linux", "/")
	if err != nil || !got {
		t.Fatalf("finding = %v, %v; want missing", got, err)
	}
}
func TestPastaNoticeRetriesAndTellsTheOwnerOnce(t *testing.T) {
	f := &pastaFleetStub{owner: "shp_owner", name: "workstation", fail: true}
	n := pastaOwnerNotice{Fleet: f, ShipID: "shp_machine", Key: "startup-key"}
	if err := n.Tell(); err == nil {
		t.Fatal("unreachable owner should be retried")
	}
	f.fail = false
	if err := n.Tell(); err != nil {
		t.Fatal(err)
	}
	if err := n.Tell(); err != nil {
		t.Fatal(err)
	}
	if f.calls != 2 || f.recipient != "shp_owner" || f.textName != "workstation" || f.key != "startup-key" {
		t.Fatalf("notice = %+v", f)
	}
}
