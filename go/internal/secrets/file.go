package secrets

import (
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"slices"
	"sync"
)

// File is the secrets file, ~/.aeolus/trierarch/secrets.json, mode 600: the secrets the trierarch plugin sent last, opened. A file that is missing or does not fit holds none. It is safe for the receiving loop that accepts secrets and the passes and the proxy that read them.
type File struct {
	Path string

	mu      sync.Mutex
	current map[string]string
}

type stored struct {
	Secrets map[string]string `json:"secrets"`
}

// Load reads the file again; one that is missing or does not fit holds none.
func (f *File) Load() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.current = nil
	text, err := os.ReadFile(f.Path)
	if err != nil {
		return
	}
	var held stored
	if json.Unmarshal(text, &held) != nil {
		return
	}
	for name, value := range held.Secrets {
		if !IsName(name) || !isValue([]byte(value)) {
			return
		}
	}
	f.current = held.Secrets
}

// Names are the names of the secrets held, in order; never a value.
func (f *File) Names() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Sorted(maps.Keys(f.current))
}

// Value is the secret's value, for the MCP proxy alone; false when none is held.
func (f *File) Value(name string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	value, ok := f.current[name]
	return value, ok
}

// Accept keeps the secrets whole, in place of those held.
func (f *File) Accept(secrets map[string]string) error {
	text, err := json.Marshal(stored{Secrets: secrets})
	if err != nil {
		return err
	}
	if err := writePrivate(f.Path, append(text, '\n')); err != nil {
		return fmt.Errorf("keep the secrets: %w", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.current = maps.Clone(secrets)
	return nil
}
