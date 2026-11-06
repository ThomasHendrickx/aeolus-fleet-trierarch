package mcpservers

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
)

// File is the MCP servers file, ~/.aeolus/trierarch/mcp-servers.json: the list the trierarch plugin sent last, as it sent it, apart from the operator's configuration, which the trierarch never writes. A file that is missing or does not fit holds none. It is safe for the receiving loop that accepts a list and the passes that read it.
type File struct {
	Path string

	mu      sync.Mutex
	current []Server
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
	if list, err := Read(string(text)); err == nil {
		f.current = list
	}
}

// Current is the list as the trierarch holds it now.
func (f *File) Current() []Server {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.current)
}

// Accept keeps the list whole, in place of the one held.
func (f *File) Accept(list []Server) error {
	text, err := json.MarshalIndent(map[string][]Server{"servers": list}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(f.Path), 0o755); err != nil {
		return err
	}
	// Written beside and renamed into place, so a stop mid-write leaves the list held.
	partial := f.Path + ".partial"
	if err := os.WriteFile(partial, append(text, '\n'), 0o644); err != nil {
		return err
	}
	if err := os.Rename(partial, f.Path); err != nil {
		return fmt.Errorf("keep the MCP servers: %w", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.current = slices.Clone(list)
	return nil
}
