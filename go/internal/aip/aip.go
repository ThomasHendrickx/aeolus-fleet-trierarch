// Package aip is the aip server every session reaches (#251, #312) and the
// name of the sealed secret its read token is, never the token: as the
// machine's configuration names it, or as the trierarch plugin sends it to
// every trierarch in its MCP server list, kept apart from the configuration. A trierarch reads the
// plugin's setting as strictly as the plugin writes it, with no field beyond
// the two.
package aip

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/secrets"
)

// Setting is the aip server and the name of the secret its read token is.
type Setting struct {
	Server      string `json:"server"`
	TokenSecret string `json:"tokenSecret"`
}

// Check says why the setting does not fit, nil when it does.
func (s Setting) Check() error {
	if s.Server == "" || s.TokenSecret == "" {
		return errors.New("aip names its server and its tokenSecret")
	}
	if server, err := url.Parse(s.Server); err != nil || (server.Scheme != "http" && server.Scheme != "https") || server.Host == "" {
		return errors.New("aip's server is an http or https URL")
	}
	if !secrets.IsName(s.TokenSecret) {
		return errors.New("aip's tokenSecret is a secret's name: lowercase letters, digits, dots, hyphens and underscores, at most 100")
	}
	return nil
}

// Read is the setting the message's payload carries, or why not.
func Read(payload string) (Setting, error) {
	var setting Setting
	decoder := json.NewDecoder(bytes.NewReader([]byte(payload)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&setting); err != nil {
		return Setting{}, errors.New(`the aip setting is { "server", "tokenSecret" }`)
	}
	if err := setting.Check(); err != nil {
		return Setting{}, err
	}
	return setting, nil
}

// InList is the setting the trierarch plugin's MCP server list carries as its aip, none when it carries none, or why not.
func InList(payload string) (*Setting, error) {
	var list struct {
		Aip json.RawMessage `json:"aip"`
	}
	if err := json.Unmarshal([]byte(payload), &list); err != nil {
		return nil, errors.New("the MCP servers are not JSON")
	}
	if list.Aip == nil {
		return nil, nil
	}
	setting, err := Read(string(list.Aip))
	if err != nil {
		return nil, err
	}
	return &setting, nil
}

// File is the aip file, ~/.aeolus/trierarch/aip.json: the setting the trierarch plugin sent last, as it sent it, apart from the operator's configuration, which the trierarch never writes. A file that is missing or does not fit holds none. It is safe for the receiving loop that accepts a setting and the starts that read it.
type File struct {
	Path string

	mu      sync.Mutex
	current *Setting
}

// Load reads the file; one that is missing or does not fit holds none.
func (f *File) Load() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.current = nil
	text, err := os.ReadFile(f.Path)
	if err != nil {
		return
	}
	if setting, err := Read(string(text)); err == nil {
		f.current = &setting
	}
}

// Current is the setting as the trierarch holds it now; false when it holds none.
func (f *File) Current() (Setting, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.current == nil {
		return Setting{}, false
	}
	return *f.current, true
}

// Accept keeps the setting, in place of the one held; none removes the one held.
func (f *File) Accept(setting *Setting) error {
	if setting == nil {
		if err := os.Remove(f.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("clear the aip setting: %w", err)
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		f.current = nil
		return nil
	}
	text, err := json.MarshalIndent(setting, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(f.Path), 0o755); err != nil {
		return err
	}
	// Written beside and renamed into place, so a stop mid-write leaves the setting held.
	partial := f.Path + ".partial"
	if err := os.WriteFile(partial, append(text, '\n'), 0o644); err != nil {
		return err
	}
	if err := os.Rename(partial, f.Path); err != nil {
		return fmt.Errorf("keep the aip setting: %w", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	kept := *setting
	f.current = &kept
	return nil
}
