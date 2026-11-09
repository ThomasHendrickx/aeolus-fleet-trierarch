package codex

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// AppServer answers Codex's one-time questions ahead through its own app
// server, as its dialogs give them, so a session nobody watches never waits
// on one: whether to trust a folder, which Codex asks on its first start
// there (trusting a repository covers its worktrees, but trusting a parent
// folder covers no repository under it), and whether to trust hooks that are
// new or changed, which Codex runs none of until it does. The hash a hook is
// trusted by is Codex's to compute.
type AppServer struct {
	// Program is the program to run, `codex` unless a test runs another.
	Program string
	// Version is the trierarch's own, which it introduces itself with.
	Version string
}

// answerTimeout is how long the app server may take to answer before the setup gives up.
const answerTimeout = 30 * time.Second

const aeolusPluginPrefix = "aeolus-fleet@"

// request is a JSON-RPC request, or a notification without an id.
type request struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type answer struct {
	ID     int             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// conversation is one run of the app server: what it is sent and the answers it gives, line by line.
type conversation struct {
	input   io.Writer
	answers chan answer
	// ended is closed once the server's output ends; stopped once the conversation is over, so the reader sends nothing more.
	ended   chan struct{}
	stopped chan struct{}
	nextID  int
}

func (c *conversation) send(message request) error {
	line, err := json.Marshal(message)
	if err != nil {
		return err
	}
	if _, err := c.input.Write(append(line, '\n')); err != nil {
		return fmt.Errorf("codex app-server ended before it read what it was sent: %w", err)
	}
	return nil
}

// ask sends the request and waits for its answer: its result, or an error naming the method it refused.
func (c *conversation) ask(method string, params any) (json.RawMessage, error) {
	c.nextID++
	id := c.nextID
	if err := c.send(request{JSONRPC: "2.0", ID: id, Method: method, Params: params}); err != nil {
		return nil, err
	}
	timeout := time.NewTimer(answerTimeout)
	defer timeout.Stop()
	for {
		select {
		case said := <-c.answers:
			if said.ID != id {
				continue
			}
			if said.Error != nil {
				return nil, fmt.Errorf("%s: %s", method, said.Error.Message)
			}
			return said.Result, nil
		case <-c.ended:
			return nil, errors.New("codex app-server ended before it answered " + method)
		case <-timeout.C:
			return nil, errors.New("codex app-server did not answer " + method)
		}
	}
}

// talk runs `codex app-server` for one conversation: introduces itself, lets the talk ask its requests, and ends the server after.
func (a AppServer) talk(talk func(c *conversation) error) error { return a.talkWith(nil, talk) }

// talkWith is talk with the configuration flags given over Codex's configuration.
func (a AppServer) talkWith(overrides []string, talk func(c *conversation) error) error {
	server := exec.Command(a.Program, append([]string{"app-server"}, overrides...)...)
	input, err := server.StdinPipe()
	if err != nil {
		return err
	}
	output, err := server.StdoutPipe()
	if err != nil {
		return err
	}
	if err := server.Start(); err != nil {
		return fmt.Errorf("codex is not installed, or %s does not run: %w", a.Program, err)
	}
	c := &conversation{input: input, answers: make(chan answer, 16), ended: make(chan struct{}), stopped: make(chan struct{})}
	go func() {
		defer close(c.ended)
		lines := bufio.NewScanner(output)
		lines.Buffer(make([]byte, 64*1024), 64*1024*1024)
		for lines.Scan() {
			var said answer
			if json.Unmarshal(lines.Bytes(), &said) != nil || said.ID == 0 {
				continue
			}
			select {
			case c.answers <- said:
			case <-c.stopped:
				return
			}
		}
	}()
	defer func() {
		close(c.stopped)
		_ = input.Close()
		_ = server.Process.Kill()
		_ = server.Wait()
	}()
	type clientInfo struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if _, err := c.ask("initialize", struct {
		ClientInfo clientInfo `json:"clientInfo"`
	}{clientInfo{Name: "aeolus-trierarch", Version: a.Version}}); err != nil {
		return err
	}
	if err := c.send(request{JSONRPC: "2.0", Method: "initialized"}); err != nil {
		return err
	}
	return talk(c)
}

// upsert is a config/batchWrite of one key path, merged into what Codex keeps.
func upsert(keyPath string, value any) any {
	type edit struct {
		KeyPath       string `json:"keyPath"`
		Value         any    `json:"value"`
		MergeStrategy string `json:"mergeStrategy"`
	}
	return struct {
		Edits            []edit `json:"edits"`
		ReloadUserConfig bool   `json:"reloadUserConfig"`
	}{Edits: []edit{{KeyPath: keyPath, Value: value, MergeStrategy: "upsert"}}, ReloadUserConfig: true}
}

// Trust trusts each folder, so a session there, or in a worktree of a repository among them, starts with no trust question.
func (a AppServer) Trust(folders []string) error {
	projects := map[string]map[string]string{}
	for _, folder := range folders {
		projects[folder] = map[string]string{"trust_level": "trusted"}
	}
	return a.talk(func(c *conversation) error {
		_, err := c.ask("config/batchWrite", upsert("projects", projects))
		return err
	})
}

// TrustAeolusHooks trusts the aeolus-fleet plugin's hooks that are new or changed, as Codex sees them from the folder, by the hash Codex gives each, and answers their keys.
func (a AppServer) TrustAeolusHooks(folder string) ([]string, error) {
	var trusted []string
	err := a.talk(func(c *conversation) error {
		listed, err := c.ask("hooks/list", map[string][]string{"cwds": {folder}})
		if err != nil {
			return err
		}
		var hooks struct {
			Data []struct {
				Hooks []struct {
					Key         string `json:"key"`
					PluginID    string `json:"pluginId"`
					CurrentHash string `json:"currentHash"`
					TrustStatus string `json:"trustStatus"`
				} `json:"hooks"`
			} `json:"data"`
		}
		if err := json.Unmarshal(listed, &hooks); err != nil {
			return fmt.Errorf("hooks/list: %w", err)
		}
		state := map[string]map[string]string{}
		for _, entry := range hooks.Data {
			for _, hook := range entry.Hooks {
				if strings.HasPrefix(hook.PluginID, aeolusPluginPrefix) && (hook.TrustStatus == "untrusted" || hook.TrustStatus == "modified") {
					state[hook.Key] = map[string]string{"trusted_hash": hook.CurrentHash}
					trusted = append(trusted, hook.Key)
				}
			}
		}
		if len(state) == 0 {
			return nil
		}
		_, err = c.ask("config/batchWrite", upsert("hooks.state", state))
		return err
	})
	if err != nil {
		return nil, err
	}
	return trusted, nil
}

// IsInstalled says whether `codex` runs on this machine.
func IsInstalled() bool {
	_, err := exec.LookPath("codex")
	return err == nil
}

// IsSignedIn says whether `codex login status` reports a login.
func IsSignedIn() bool {
	return exec.Command("codex", "login", "status").Run() == nil
}

// Subscription is what Codex reads itself before a session on its subscription starts (api keys K6): how it is logged in, as `codex login status` says.
type Subscription struct {
	// Program is the program to run, `codex` unless a test runs another.
	Program string
}

// Problem is why a session would reach a key on its subscription: Codex logged in with an API key, not ChatGPT; empty otherwise. Its line may show part of the key, so only the kind is kept.
func (s Subscription) Problem(options map[string]string, folder string) string {
	program := s.Program
	if program == "" {
		program = "codex"
	}
	// It says how it is logged in, and exits other than 0 when it is not: the text alone tells.
	said, _ := exec.Command(program, "login", "status").CombinedOutput()
	if loginKindOf(string(said)) != "apiKey" {
		return ""
	}
	return "codex is logged in with an API key, not ChatGPT: log Codex in with ChatGPT (codex logout, then codex login), or run the ship on its API key"
}

var (
	usingChatGPT = regexp.MustCompile(`(?i)using ChatGPT`)
	usingAPIKey  = regexp.MustCompile(`(?i)API key`)
)

// loginKindOf is how `codex login status` says Codex is logged in: chatgpt, apiKey or none.
func loginKindOf(said string) string {
	switch {
	case usingChatGPT.MatchString(said):
		return "chatgpt"
	case usingAPIKey.MatchString(said):
		return "apiKey"
	}
	return "none"
}
