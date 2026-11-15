package runpass

import (
	"fmt"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

// usageLimitReader is a harness whose latest turn's usage-limit stop is recognised.
type usageLimitReader interface {
	UsageLimit(reconciler.Entry) (occurrence string, reason string)
}

// reportUsageLimits reports stops every pass without changing session or restart policy (#1629).
func (p Pass) reportUsageLimits(state reconciler.State) reconciler.State {
	for _, shipID := range sortedIDs(state.Entries) {
		entry := state.Entries[shipID]
		reader, ok := p.Harnesses[entry.Harness].(usageLimitReader)
		if !ok || entry.Folder == "" || entry.CrewToken == "" || entry.State == "releasing" {
			continue
		}
		occurrence, reason := reader.UsageLimit(entry)
		if occurrence == "" || occurrence == entry.UsageLimitTold {
			continue
		}
		note := entry.Harness + " usage limit reached: " + reason
		if err := p.Fleet.ReportFor(entry.CrewToken, "blocked", note); err != nil {
			p.Log(fmt.Sprintf("Usage-limit stop for %s was not reported: %v; the next pass tries again", shipID, err))
			continue
		}
		recipient, err := p.Fleet.UsageLimitRecipient(shipID)
		if err != nil {
			p.Log(fmt.Sprintf("Usage-limit recipient for %s was not read: %v; the next pass tries again", shipID, err))
			continue
		}
		if recipient == "" {
			continue
		}
		key := fmt.Sprintf("trierarch:usage-limit:%s:%d:%s", shipID, entry.SettingsVersion, occurrence)
		refusal, err := p.Fleet.ReportToOwner(recipient, nameOf(entry)+" reached its usage limit\n\n"+note, key)
		if err != nil || refusal != nil {
			p.Log(fmt.Sprintf("Usage-limit notice for %s was not sent; the next pass tries again", shipID))
			continue
		}
		entry.UsageLimitTold = occurrence
		next, err := p.put(state, entry)
		if err != nil {
			p.Log(fmt.Sprintf("Usage-limit notice for %s was not marked sent: %v; the next pass tries again", shipID, err))
			continue
		}
		state = next
	}
	return state
}
