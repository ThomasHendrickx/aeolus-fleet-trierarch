// Package keys is each harness's API key on this computer (docs/trierarch.md,
// "API keys"): one file per harness in `~/.aeolus/trierarch/keys/`, mode 600
// in a folder of mode 700, which only `login` writes and only the model proxy
// reads; and the key's state, as its vendor's answers say it, which the proxy
// records and the trierarch reads.
package keys

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// Files are the key files, one per harness, in Folder.
type Files struct {
	Folder string
}

func (f Files) fileOf(harness string) string {
	return filepath.Join(f.Folder, harness)
}

// Has is whether the harness holds a key file.
func (f Files) Has(harness string) bool {
	_, err := os.Stat(f.fileOf(harness))
	return err == nil
}

// Read is the harness's key, for the model proxy alone; false when it holds none.
func (f Files) Read(harness string) (string, bool) {
	text, err := os.ReadFile(f.fileOf(harness))
	key := strings.TrimSpace(string(text))
	return key, err == nil && key != ""
}

// Write keeps the key for the harness, written beside its file first, so the proxy never reads half a key.
func (f Files) Write(harness string, key string) error {
	if err := os.MkdirAll(f.Folder, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(f.Folder, 0o700); err != nil {
		return err
	}
	next := f.fileOf(harness) + ".next"
	if err := os.WriteFile(next, []byte(key), 0o600); err != nil {
		return err
	}
	if err := os.Chmod(next, 0o600); err != nil {
		return err
	}
	return os.Rename(next, f.fileOf(harness))
}

// Remove removes the harness's key, and says whether there was one.
func (f Files) Remove(harness string) (bool, error) {
	err := os.Remove(f.fileOf(harness))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// State is where a harness's key stands (api keys K8).
type State string

const (
	None        State = "none"
	Ready       State = "ready"
	Refused     State = "refused"
	OutOfCredit State = "outOfCredit"
)

// StateAt is a key's state, and since when for one its vendor's answer set (ISO 8601).
type StateAt struct {
	State State  `json:"state"`
	At    string `json:"at,omitempty"`
}

// keyFile is a key file's identity, never its content, in the shape today's trierarch keeps it.
type keyFile struct {
	Ino     uint64  `json:"ino"`
	MtimeMs float64 `json:"mtimeMs"`
}

// isSame is whether both name one key file; mtimeMs is a float another trierarch may round in its last digit.
func (k keyFile) isSame(other keyFile) bool {
	return k.Ino == other.Ino && math.Abs(k.MtimeMs-other.MtimeMs) < 1e-3
}

type recorded struct {
	State   State   `json:"state"`
	At      string  `json:"at"`
	KeyFile keyFile `json:"keyFile"`
}

// States are each harness's key state, kept in File for the key file it was said of: a new key, which login writes as a new file, is ready again, and no key is none.
type States struct {
	Keys string
	File string
}

func (s States) keyFileOf(harness string) (keyFile, bool) {
	info, err := os.Stat(filepath.Join(s.Keys, harness))
	if err != nil {
		return keyFile{}, false
	}
	modified := info.ModTime()
	identity := keyFile{MtimeMs: float64(modified.Unix())*1e3 + float64(modified.Nanosecond())/1e6}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		identity.Ino = uint64(stat.Ino)
	}
	return identity, true
}

func (s States) recorded() map[string]recorded {
	all := map[string]recorded{}
	text, err := os.ReadFile(s.File)
	if err != nil || json.Unmarshal(text, &all) != nil {
		return map[string]recorded{}
	}
	return all
}

// StateOf is the harness's key state.
func (s States) StateOf(harness string) StateAt {
	identity, ok := s.keyFileOf(harness)
	if !ok {
		return StateAt{State: None}
	}
	said, isSaid := s.recorded()[harness]
	if isSaid && (said.State == Refused || said.State == OutOfCredit) && said.KeyFile.isSame(identity) {
		return StateAt{State: said.State, At: said.At}
	}
	return StateAt{State: Ready}
}

// Stamp is a time as today's trierarch writes it, to the millisecond in UTC.
func Stamp(at time.Time) string {
	return at.UTC().Format("2006-01-02T15:04:05.000Z")
}

// Record keeps what a vendor's answer said of the harness's key at the time: a state it already has keeps its time, and a refused key stays refused until a new key.
func (s States) Record(harness string, said State, at time.Time) error {
	identity, hasKey := s.keyFileOf(harness)
	all := s.recorded()
	before, wasSaid := all[harness]
	isBefore := wasSaid && hasKey && before.KeyFile.isSame(identity)
	switch {
	case isBefore && before.State == Refused:
		return nil
	case said == Ready && !wasSaid:
		return nil
	case said != Ready && (!hasKey || (isBefore && before.State == said)):
		return nil
	}
	if said == Ready || !hasKey {
		delete(all, harness)
	} else {
		all[harness] = recorded{State: said, At: Stamp(at), KeyFile: identity}
	}
	if err := os.MkdirAll(filepath.Dir(s.File), 0o700); err != nil {
		return err
	}
	text, err := json.Marshal(all)
	if err != nil {
		return err
	}
	next := s.File + ".next"
	if err := os.WriteFile(next, text, 0o600); err != nil {
		return err
	}
	return os.Rename(next, s.File)
}

// anthropicCredit is how Anthropic says a spend limit or an empty balance: it names no code of its own for them.
var anthropicCredit = regexp.MustCompile(`(?i)credit balance|usage limits|spend limit`)

var openAICredit = []string{"insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded"}

// StateOfAnswer is what a vendor's answer to a request on a key says of the key (api keys K9), as each vendor documents its errors: refused for a key it does not take, out of credit for a billing problem or a spend limit; empty for a rate limit or a server error, which the harness waits out and retries.
func StateOfAnswer(harness string, status int, body string) State {
	if status >= 200 && status < 300 {
		return Ready
	}
	if status == 401 {
		return Refused
	}
	var answer struct {
		Error struct {
			Type    *string `json:"type"`
			Code    *string `json:"code"`
			Message string  `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal([]byte(body), &answer)
	if harness == "claude-code" {
		if status == 402 || (answer.Error.Type != nil && *answer.Error.Type == "billing_error") || anthropicCredit.MatchString(answer.Error.Message) {
			return OutOfCredit
		}
		return ""
	}
	for _, name := range []*string{answer.Error.Code, answer.Error.Type} {
		for _, credit := range openAICredit {
			if name != nil && *name == credit {
				return OutOfCredit
			}
		}
	}
	return ""
}
