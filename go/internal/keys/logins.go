package keys

import (
	"fmt"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

// Logins are which login each session starts on (api keys K5), as the configuration gives them, and whether it can start on it now (K9), as its key's state says: on an API key only once its harness holds one that is ready, so a session never starts to be refused by the proxy, nor on its subscription instead (K2).
type Logins struct {
	Configured *config.Logins
	States     States
}

// LoginOf is the ship's own login, else its harness's default, else its subscription.
func (l Logins) LoginOf(harness string, shipName string) string {
	if l.Configured == nil {
		return "subscription"
	}
	if login, ok := l.Configured.Ships[shipName]; ok && login != "" {
		return login
	}
	if defaults := l.Configured.Default; defaults != nil {
		login := map[string]string{"claude-code": defaults.ClaudeCode, "codex": defaults.Codex}[harness]
		if login != "" {
			return login
		}
	}
	return "subscription"
}

// StartProblem is why a session of the harness cannot start on the login now, empty when it can.
func (l Logins) StartProblem(harness string, login string) string {
	if login != "apiKey" {
		return ""
	}
	key := l.States.StateOf(harness)
	switch key.State {
	case None:
		return fmt.Sprintf("%s has no API key on this computer: aeolus-trierarch login %s --api-key", harness, harness)
	case Refused:
		return fmt.Sprintf("%s's API key was refused by its vendor since %s: give it a new one with aeolus-trierarch login %s --api-key", harness, key.At, harness)
	case OutOfCredit:
		return fmt.Sprintf("%s's API key is out of credit since %s: it is checked every 15 minutes, or at once with aeolus-trierarch login %s --check", harness, key.At, harness)
	}
	return ""
}

// IsKeyReady is whether the harness's key is ready.
func (l Logins) IsKeyReady(harness string) bool {
	return l.States.StateOf(harness).State == Ready
}
