// Package trusted is the trusted repositories (aeolus-fleet#384): the
// trierarch plugin's one list of the repositories a trierarch may clone on
// demand, each by the name a crew request's workspace gives it and its git
// URL. A trierarch reads the list it receives as strictly as the trierarch
// plugin wrote it: a URL never holds a credential, and is never a path, a file
// URL or a remote helper, so a clone uses only the access the machine holds.
package trusted

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

// ListContentType is the content type of the message that carries the list from the trierarch plugin.
const ListContentType = "application/vnd.aeolus.trierarch.trusted-repositories+json"

// RequestContentType is the content type of the message a trierarch asks the trierarch plugin's ship for the list again with.
const RequestContentType = "application/vnd.aeolus.trierarch.trusted-repositories-request+json"

// nameMaxLength is the most a name holds, as common gives it.
const nameMaxLength = 100

var namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)

// scpLike is git's scp-like ssh form, user@host:path. Neither user, host nor path may start with a dash, which ssh would read as an option.
var scpLike = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[^\s-]\S*$`)

// Repository is a repository a trierarch may clone on demand: its name and its git URL.
type Repository struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

// errURLRefused is why a URL is refused.
var errURLRefused = errors.New("a trusted repository is an https:// or ssh URL, never a path, a file URL or a credential")

// isOptionUser says whether the URL's user reads as an ssh option; the user is decoded already, and one that does not decode is no user git can take either.
func isOptionUser(user *url.Userinfo) bool {
	return strings.HasPrefix(user.Username(), "-")
}

// isCloneable says whether git may clone from the URL with the machine's own access: https with no user (a user there is a token), or ssh with no password and no user or host that reads as an option.
func isCloneable(text string) bool {
	if strings.IndexFunc(text, unicode.IsSpace) >= 0 {
		return false
	}
	if scpLike.MatchString(text) {
		return true
	}
	parsed, err := url.Parse(text)
	if err != nil {
		return false
	}
	hasRepository := len(parsed.EscapedPath()) > 1
	host := parsed.Hostname()
	hasSafeHost := host != "" && !strings.HasPrefix(host, "-")
	password, _ := parsed.User.Password()
	switch parsed.Scheme {
	case "https":
		return hasRepository && hasSafeHost && parsed.User.Username() == "" && password == ""
	case "ssh":
		return hasRepository && hasSafeHost && password == "" && !isOptionUser(parsed.User)
	}
	return false
}

// nameProblem is why the name is no name a trierarch gives a repository, empty when it is one.
func nameProblem(name string) string {
	switch {
	case len(name) > nameMaxLength:
		return fmt.Sprintf("A name is at most %d characters", nameMaxLength)
	case !namePattern.MatchString(name):
		return "A name is lowercase letters, digits, dots, hyphens and underscores, and never a path"
	}
	return ""
}

// Read is the list from the message's payload, or why not: each name a name given once, each URL one git clones with the machine's access.
func Read(payload string) ([]Repository, error) {
	if !json.Valid([]byte(payload)) {
		return nil, errors.New("the trusted repositories are not JSON")
	}
	shape := errors.New(`the trusted repositories are { "repositories": [{ "name", "url" }] }`)
	var message struct {
		Repositories json.RawMessage `json:"repositories"`
	}
	if json.Unmarshal([]byte(payload), &message) != nil {
		return nil, shape
	}
	var entries []*struct {
		Name any `json:"name"`
		URL  any `json:"url"`
	}
	if len(message.Repositories) == 0 || string(message.Repositories) == "null" || json.Unmarshal(message.Repositories, &entries) != nil {
		return nil, shape
	}
	list := []Repository{}
	for _, entry := range entries {
		if entry == nil {
			return nil, shape
		}
		name, isText := entry.Name.(string)
		if !isText {
			return nil, fmt.Errorf("%v: not a name", entry.Name)
		}
		if problem := nameProblem(name); problem != "" {
			return nil, fmt.Errorf("%s: %s", name, problem)
		}
		for _, each := range list {
			if each.Name == name {
				return nil, fmt.Errorf("%s: a trusted repository is named once", name)
			}
		}
		text, isText := entry.URL.(string)
		if !isText || !isCloneable(text) {
			return nil, fmt.Errorf("%s: %w", name, errURLRefused)
		}
		list = append(list, Repository{Name: name, URL: text})
	}
	return list, nil
}
