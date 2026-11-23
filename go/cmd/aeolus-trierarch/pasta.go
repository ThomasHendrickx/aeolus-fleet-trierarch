package main

import "errors"

// pastaProfile is the host fact the startup check needs; the adapter reads it.
type pastaProfile interface {
	PastaAppArmor(osName string, root string) (bool, error)
}

func checkPastaAppArmor(profile pastaProfile, osName, root string) (bool, error) {
	return profile.PastaAppArmor(osName, root)
}

type pastaNoticeFleet interface {
	OwnerOf(shipID string) (string, error)
	Name() (string, error)
	TellPastaAppArmor(ownerID, shipName, key string) error
}

type pastaOwnerNotice struct {
	Fleet       pastaNoticeFleet
	ShipID, Key string
	sent        bool
}

// Tell retries a failed notice with the same key until the fleet accepts it.
func (n *pastaOwnerNotice) Tell() error {
	if n.sent {
		return nil
	}
	owner, err := n.Fleet.OwnerOf(n.ShipID)
	if err != nil {
		return err
	}
	if owner == "" {
		return errors.New("the trierarch ship has no owner")
	}
	name, err := n.Fleet.Name()
	if err != nil {
		return err
	}
	if err := n.Fleet.TellPastaAppArmor(owner, name, n.Key); err != nil {
		return err
	}
	n.sent = true
	return nil
}
