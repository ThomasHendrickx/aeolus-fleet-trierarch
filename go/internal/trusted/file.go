package trusted

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sync"
)

// File is the trusted repositories file, ~/.aeolus/trierarch/trusted-repositories.json: the list the trierarch plugin sent last, as it sent it, apart from the operator's configuration, which the trierarch never writes. A file that is missing or does not fit holds none, so a list written by hand trusts nothing. Each repository's clone is <clones root>/<name>. It is safe for the receiving loop that accepts a list and the passes that read it.
type File struct {
	Path       string
	ClonesRoot string
	// TrustClones trusts the clones' paths for every configured harness, as adding a place does (#381).
	TrustClones func(paths []string) error

	mu      sync.Mutex
	current []Repository
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
func (f *File) Current() []Repository {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.current)
}

// CloneOf is where the repository's clone is.
func (f *File) CloneOf(name string) string {
	return filepath.Join(f.ClonesRoot, name)
}

// Accept trusts each repository's clone, then keeps the list whole: a list whose clones could not be trusted is not kept, so the delivery comes again.
func (f *File) Accept(list []Repository) error {
	paths := []string{}
	for _, repository := range list {
		paths = append(paths, f.CloneOf(repository.Name))
	}
	if err := f.TrustClones(paths); err != nil {
		return err
	}
	text, err := json.MarshalIndent(map[string][]Repository{"repositories": list}, "", "  ")
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
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.current = slices.Clone(list)
	return nil
}
