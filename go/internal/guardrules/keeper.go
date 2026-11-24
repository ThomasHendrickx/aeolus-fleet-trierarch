package guardrules

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sync"
)

// Outcome is whether a rules delivery was applied, repeated, or refused.
type Outcome int

const (
	// Applied means the complete resolution was persisted.
	Applied Outcome = iota + 1
	// Unchanged means this version and content were already persisted.
	Unchanged
	// Refused means the delivery was rejected and the stored rules stayed.
	Refused
)

// Store persists one complete rules resolution per ship outside its worktree.
// Read returns nil when none exists; Write replaces the file atomically.
type Store interface {
	Read(context.Context, string) ([]byte, error)
	Write(context.Context, string, []byte) error
}

// Keeper takes rules only from its configured plugin ship. One keeper owns
// delivery acceptance for the receiving loop and serializes version changes.
type Keeper struct {
	Identity Identity
	Store    Store
	mu       sync.Mutex
}

// Accept validates and persists a resolution before it can be acknowledged.
// A refused message returns Refused; storage failures return a zero outcome,
// so the delivery is retried rather than acknowledged.
func (k *Keeper) Accept(ctx context.Context, sender string, payload string) (Outcome, error) {
	if sender == "" || sender != k.Identity.PluginShipID {
		return Refused, fmt.Errorf("%w: sender is not the plugin ship", ErrRefused)
	}
	incoming, err := Read(payload, k.Identity)
	if err != nil {
		return Refused, err
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	held, ok, err := k.current(ctx, incoming.ShipID)
	if err != nil {
		return 0, err
	}
	text, err := json.Marshal(incoming)
	if err != nil {
		return 0, fmt.Errorf("encode guard rules: %w", err)
	}
	if ok {
		if incoming.SettingsVersion < held.SettingsVersion {
			return Refused, fmt.Errorf("%w: settings version is older than the stored rules", ErrRefused)
		}
		if incoming.SettingsVersion == held.SettingsVersion {
			previous, err := json.Marshal(held)
			if err != nil {
				return 0, fmt.Errorf("encode stored guard rules: %w", err)
			}
			if !bytes.Equal(text, previous) {
				return Refused, fmt.Errorf("%w: settings version already has other rules", ErrRefused)
			}
			return Unchanged, nil
		}
	}
	if err := k.Store.Write(ctx, incoming.ShipID, text); err != nil {
		return 0, fmt.Errorf("persist guard rules for %s: %w", incoming.ShipID, err)
	}
	return Applied, nil
}

// Current reads the persisted resolution without contacting the fleet, so a
// restart uses exactly the rules kept with the ship.
func (k *Keeper) Current(ctx context.Context, shipID string) (Assignment, bool, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.current(ctx, shipID)
}

func (k *Keeper) current(ctx context.Context, shipID string) (Assignment, bool, error) {
	text, err := k.Store.Read(ctx, shipID)
	if err != nil {
		return Assignment{}, false, fmt.Errorf("read guard rules for %s: %w", shipID, err)
	}
	if text == nil {
		return Assignment{}, false, nil
	}
	held, err := Read(string(text), k.Identity)
	if err != nil {
		return Assignment{}, false, fmt.Errorf("stored guard rules for %s: %w", shipID, err)
	}
	if held.ShipID != shipID {
		return Assignment{}, false, fmt.Errorf("stored guard rules do not belong to ship %s", shipID)
	}
	return held, true, nil
}
