// Package mask replaces credentials held by the trierarch before local content is shown.
package mask

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
)

// Files opens credential files and their containing directories.
type Files interface{ Open(string) (fs.File, error) }

// Loader reads credentials through its file port; its zero value uses disk.
type Loader struct{ Files Files }

// Masker holds replacements privately. Its zero value suppresses all content.
type Masker struct{ replacer *strings.Replacer }

// Line replaces known values, as written or JSON-escaped, without cutting content.
func (m Masker) Line(text string) string {
	if m.replacer == nil {
		return ""
	}
	return m.replacer.Replace(text)
}

type disk struct{}

func (disk) Open(path string) (fs.File, error) { return os.Open(path) }

// Load reads all credential sources on this computer, without changing any file.
func Load(at paths.Paths) (Masker, error) { return (Loader{}).Load(at) }

// Load refuses content if a present credential source cannot be read or decoded.
// Absent optional sources hold no credential and do not prevent masking.
func (l Loader) Load(at paths.Paths) (Masker, error) {
	files := l.Files
	if files == nil {
		files = disk{}
	}
	values := map[string]string{}
	add := func(value, which string) {
		if value == "" {
			return
		}
		label := "[masked: " + which + "]"
		for _, html := range []bool{false, true} {
			var encoded bytes.Buffer
			encoder := json.NewEncoder(&encoded)
			encoder.SetEscapeHTML(html)
			_ = encoder.Encode(value)
			text := strings.TrimSuffix(encoded.String(), "\n")
			if _, exists := values[text[1:len(text)-1]]; !exists {
				values[text[1:len(text)-1]] = label
			}
		}
		if _, exists := values[value]; !exists {
			values[value] = label
		}
	}
	read := func(path string, target any) error {
		data, err := readFile(files, path)
		if errors.Is(err, fs.ErrNotExist) && path != at.State {
			return nil
		}
		if err != nil {
			return cannotRead(path, err)
		}
		if target == nil {
			return nil
		}
		if text, ok := target.(*string); ok {
			*text = strings.TrimSpace(string(data))
			return nil
		}
		if json.Unmarshal(data, target) != nil {
			return cannotRead(path, errors.New("invalid credential JSON"))
		}
		return nil
	}
	var state struct {
		Entries map[string]struct {
			CrewToken string `json:"crewToken"`
		} `json:"entries"`
	}
	if err := read(at.State, &state); err != nil {
		return Masker{}, err
	}
	for _, name := range sortedKeys(state.Entries) {
		add(state.Entries[name].CrewToken, "crew token")
	}
	for _, source := range []struct{ path, which string }{{at.CrewToken, "trierarch crew token"}, {at.ModelToken, "model token"}, {at.SealingKey, "sealing key"}} {
		var value string
		if err := read(source.path, &value); err != nil {
			return Masker{}, err
		}
		add(value, source.which)
	}
	keys, err := directory(files, at.Keys)
	if err != nil {
		return Masker{}, err
	}
	for _, key := range keys {
		var value string
		if err := read(filepath.Join(at.Keys, key.Name()), &value); err != nil {
			return Masker{}, err
		}
		add(value, key.Name()+" API key")
	}
	var configuration struct {
		Secrets map[string]string `json:"secrets"`
	}
	if err := read(at.McpConfiguration, &configuration); err != nil {
		return Masker{}, err
	}
	for _, name := range sortedKeys(configuration.Secrets) {
		add(configuration.Secrets[name], "MCP secret "+name)
	}
	sessions, err := directory(files, at.Sessions)
	if err != nil {
		return Masker{}, err
	}
	for _, session := range sessions {
		if !session.IsDir() {
			continue
		}
		folder := filepath.Join(at.Sessions, session.Name())
		// Check the directory itself too: inability to enumerate it must fail closed.
		if _, err := directory(files, folder); err != nil {
			return Masker{}, err
		}
		for _, source := range []struct{ name, which string }{{"proxy-token", "model proxy token"}, {"mcp-access", "MCP token"}} {
			var token struct {
				Token string `json:"token"`
			}
			if err := read(filepath.Join(folder, source.name), &token); err != nil {
				return Masker{}, err
			}
			add(token.Token, source.which)
		}
		var config struct {
			Servers map[string]struct {
				Headers map[string]string `json:"headers"`
			} `json:"mcpServers"`
		}
		if err := read(filepath.Join(folder, "mcp-config.json"), &config); err != nil {
			return Masker{}, err
		}
		for _, name := range sortedKeys(config.Servers) {
			for _, header := range sortedKeys(config.Servers[name].Headers) {
				value := config.Servers[name].Headers[header]
				if strings.EqualFold(header, "Authorization") {
					value = strings.TrimPrefix(value, "Bearer ")
				}
				add(value, "MCP token")
			}
		}
		var env map[string]string
		if err := read(filepath.Join(folder, "secret-env.json"), &env); err != nil {
			return Masker{}, err
		}
		for _, name := range sortedKeys(env) {
			add(env[name], "secret variable "+name)
		}
	}
	ordered := sortedKeys(values)
	slices.SortStableFunc(ordered, func(a, b string) int { return len(b) - len(a) })
	pairs := make([]string, 0, len(ordered)*2)
	for _, value := range ordered {
		pairs = append(pairs, value, values[value])
	}
	return Masker{replacer: strings.NewReplacer(pairs...)}, nil
}

func sortedKeys[V any](values map[string]V) []string {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

func readFile(files Files, path string) ([]byte, error) {
	file, err := files.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(file)
}

func directory(files Files, path string) ([]fs.DirEntry, error) {
	file, err := files.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, cannotRead(path, err)
	}
	defer file.Close()
	dir, ok := file.(fs.ReadDirFile)
	if !ok {
		return nil, cannotRead(path, errors.New("not a readable directory"))
	}
	entries, err := dir.ReadDir(-1)
	if err != nil {
		return nil, cannotRead(path, err)
	}
	slices.SortFunc(entries, func(a, b fs.DirEntry) int { return strings.Compare(a.Name(), b.Name()) })
	return entries, nil
}

func cannotRead(path string, err error) error {
	var failure *fs.PathError
	if errors.As(err, &failure) {
		err = failure.Err
	}
	return fmt.Errorf("cannot read %s to mask it (%w)", path, err)
}
