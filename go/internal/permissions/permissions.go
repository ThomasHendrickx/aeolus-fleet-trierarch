// Package permissions denies permission requests that cannot reach a person.
// The owner is read for every call; no approval or owner is cached.
package permissions

import "context"

// Server is Claude Code's private permission MCP server name.
const Server = "aeolus-permissions"

// Owner identifies whether a ship has a person who can answer.
type Owner struct {
	IsPerson bool `json:"isPerson"`
}

// OwnerReader reads the current owner of one ship.
type OwnerReader interface {
	Owner(context.Context, string) (Owner, error)
}

// Decision is the JSON Claude Code reads from one text content.
type Decision struct {
	Behavior string `json:"behavior"`
	Message  string `json:"message"`
}

// Deny reads the owner and refuses with the reason. Person questions arrive in a later slice.
func Deny(ctx context.Context, ship string, owners OwnerReader) Decision {
	owner, err := owners.Owner(ctx, ship)
	message := "this ship's owner is argo: nobody is asked"
	if err != nil {
		message = "could not read this ship's owner: nobody is asked"
	} else if owner.IsPerson {
		message = "permission questions for person-owned ships are not available yet"
	}
	return Decision{Behavior: "deny", Message: message}
}
