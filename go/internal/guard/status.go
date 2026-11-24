package guard

import "time"

// Status is what the guard applied to a session and what it refused, as the crew status carries it (aeolus-fleet docs/design/guard,
// section 4.8): the sets at their commits, how many refusals, and the last twenty.
type Status struct {
	// SettingsVersion is the settings version the rules it applies were kept for, which it is reported with; not part of the status.
	SettingsVersion int             `json:"-"`
	Sets            []AppliedSet    `json:"sets"`
	Refusals int             `json:"refusals"`
	Recent   []RecentRefusal `json:"recent"`
}

// AppliedSet is a rule set the guard applies, at the commit it was resolved to, and whether the fleet's floor names it.
type AppliedSet struct {
	Name       string `json:"name"`
	Repository string `json:"repository"`
	Commit     string `json:"commit"`
	Floor      bool   `json:"floor"`
}

// RecentRefusal is a refusal as the status shows it: no summary of the call. Set and Commit are nil for a refusal by the mechanism.
type RecentRefusal struct {
	At     time.Time `json:"at"`
	Tool   string    `json:"tool"`
	Rule   string    `json:"rule"`
	Set    *string   `json:"set"`
	Commit *string   `json:"commit"`
}

// RecentRefusals is how many of the last refusals a status shows.
const RecentRefusals = 20
