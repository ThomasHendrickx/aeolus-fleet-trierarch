package keys

import (
	"fmt"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

// Logins are which login each session starts on (api keys K5), as the configuration gives them, and whether it can start on it now (K9), as its key's state says: on an API key only once its harness holds one that is ready, so a session never starts to be refused by the proxy, nor on its subscription instead (K2).
type Logins struct {
	Configured *config.Logins
	States     States
	// Subscriptions are, by harness, what it reads itself that would put a key in reach of a session on its subscription (K6); a harness with none puts none in reach.
	Subscriptions map[string]Subscription
}

// Subscription is what a harness reads itself before a session on its subscription starts.
type Subscription interface {
	// Problem is why a session with the options, in the folder, would reach a key, naming what and where but never its value; empty when nothing does.
	Problem(options map[string]string, folder string) string
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

// StartProblem is why a session of the harness, with the options, in the folder, cannot start on the login now, empty when it can: on its subscription, a key in reach (K6).
func (l Logins) StartProblem(harness string, login string, options map[string]string, folder string) string {
	if login != "apiKey" {
		if subscription, ok := l.Subscriptions[harness]; ok {
			return subscription.Problem(options, folder)
		}
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

// KeyState is where the harness's key stands and since when, as the model proxy's vendor answers set it.
func (l Logins) KeyState(harness string) (string, string) {
	key := l.States.StateOf(harness)
	return string(key.State), key.At
}
