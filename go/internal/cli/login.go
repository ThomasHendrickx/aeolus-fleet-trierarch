package cli

import (
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/keys"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/modelproxy"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/paths"
)

// HarnessLogin is a harness as login says it: its default login and whether it holds a key.
type HarnessLogin struct {
	Harness string `json:"harness"`
	// Default is the login its sessions run on; a harness with no default runs on its subscription (K5).
	Default string `json:"default"`
	// Key is ready or none: a key is written only once its vendor took it (K8).
	Key string `json:"key"`
}

// ShipLogin is a ship the configuration names, on its own login.
type ShipLogin struct {
	ShipName string `json:"shipName"`
	Login    string `json:"login"`
}

// LoginReport is what login answers, in the shape today's trierarch answers it.
type LoginReport struct {
	Harnesses []HarnessLogin `json:"harnesses"`
	Ships     []ShipLogin    `json:"ships"`
	Said      []string       `json:"said"`
}

var harnessNames = map[string]string{"claude-code": "Claude Code", "codex": "Codex"}
var loginNames = map[string]string{"apiKey": "API key", "subscription": "Subscription"}

// loginWords are the logins a command line names, and default where it may clear one.
var loginWords = map[string]string{"api-key": "apiKey", "subscription": "subscription", "default": "default"}

const copilotRefusal = "copilot signs in with this computer's own login (copilot login), never an API key: the trierarch keeps no Copilot key and runs every Copilot session on that login"

// login is `aeolus-trierarch login` (api keys K11): it keeps a harness's API key on this computer, chooses which login each harness and ship runs on, and says them. A key comes in on stdin, never a flag, so it stays out of the shell history; it is written only once its vendor takes it, and never said back (K7). The logins go in the configuration (K5). Every change restarts the service; sessions keep running, each on the login it started with (K3).
func login(at paths.Paths, machine Machine, command parsed) (answer, error) {
	said, err := changeLogin(at, machine, command)
	if err != nil {
		return answer{}, err
	}
	// Before init there is no configuration: every harness then runs on its subscription.
	var logins config.Logins
	if configuration, err := config.Load(at.Config); err == nil && configuration.Logins != nil {
		logins = *configuration.Logins
	}
	held := keys.Files{Folder: at.Keys}
	report := LoginReport{Harnesses: []HarnessLogin{}, Ships: []ShipLogin{}, Said: said}
	for _, harness := range modelproxy.Harnesses {
		each := HarnessLogin{Harness: harness, Default: defaultOf(logins, harness), Key: "none"}
		if held.Has(harness) {
			each.Key = "ready"
		}
		report.Harnesses = append(report.Harnesses, each)
	}
	for _, name := range slices.Sorted(maps.Keys(logins.Ships)) {
		report.Ships = append(report.Ships, ShipLogin{ShipName: name, Login: logins.Ships[name]})
	}
	if len(command.words) == 1 && !isChange(command) {
		report.Said = showLines(report)
	}
	return answer{data: report, text: strings.Join(report.Said, "\n")}, nil
}

func isChange(command parsed) bool {
	_, isDefault := command.values["--default"]
	_, isShip := command.values["--ship"]
	return command.switches["--api-key"] || command.switches["--remove-key"] || command.switches["--check"] || isDefault || isShip
}

func defaultOf(logins config.Logins, harness string) string {
	login := ""
	if logins.Default != nil {
		login = map[string]string{"claude-code": logins.Default.ClaudeCode, "codex": logins.Default.Codex}[harness]
	}
	if login == "" {
		return "subscription"
	}
	return login
}

// showLines say each harness's default and key, then each ship on its own login.
func showLines(report LoginReport) []string {
	width := 0
	for _, name := range harnessNames {
		width = max(width, len(name))
	}
	for _, ship := range report.Ships {
		width = max(width, len(ship.ShipName))
	}
	loginWidth := len(loginNames["subscription"])
	pad := func(text string, to int) string { return text + strings.Repeat(" ", max(0, to-len(text))) }
	lines := []string{}
	for _, harness := range report.Harnesses {
		key := "no API key"
		if harness.Key == "ready" {
			key = "API key ready"
		}
		lines = append(lines, fmt.Sprintf("%s  default %s  %s", pad(harnessNames[harness.Harness], width), pad(loginNames[harness.Default], loginWidth), key))
	}
	for _, ship := range report.Ships {
		lines = append(lines, fmt.Sprintf("%s  %s", pad(ship.ShipName, width), loginNames[ship.Login]))
	}
	return lines
}

// changeLogin carries out what the command line asks and answers what it says of it; nothing for login alone.
func changeLogin(at paths.Paths, machine Machine, command parsed) ([]string, error) {
	word := ""
	if len(command.words) == 2 {
		word = command.words[1]
	}
	if shipName, ok := command.values["--ship"]; ok {
		login, ok := loginWords[word]
		if !ok {
			return nil, errors.New("a ship's login is api-key, subscription or default: aeolus-trierarch login --ship build-docs api-key")
		}
		return setShipLogin(at, machine, shipName, login)
	}
	if word == "" && !isChange(command) {
		return nil, nil
	}
	if word == "copilot" {
		return nil, errors.New(copilotRefusal)
	}
	defaultWord, isDefault := command.values["--default"]
	asked := 0
	for _, each := range []bool{command.switches["--api-key"], command.switches["--remove-key"], command.switches["--check"], isDefault} {
		if each {
			asked++
		}
	}
	if !slices.Contains(modelproxy.Harnesses, word) || asked != 1 {
		return nil, errors.New("login takes claude-code or codex: aeolus-trierarch login claude-code --api-key")
	}
	name := harnessNames[word]
	held := keys.Files{Folder: at.Keys}
	switch {
	case isDefault:
		login, ok := loginWords[defaultWord]
		if !ok || login == "default" {
			return nil, fmt.Errorf("a login is api-key or subscription: aeolus-trierarch login %s --default api-key", word)
		}
		isChanged, err := writeLogins(at, func(logins *config.Logins) {
			if logins.Default == nil {
				logins.Default = &config.DefaultLogins{}
			}
			if word == "claude-code" {
				logins.Default.ClaudeCode = login
			} else {
				logins.Default.Codex = login
			}
		})
		if err != nil {
			return nil, err
		}
		if !isChanged {
			return []string{fmt.Sprintf("%s runs on %s by default already.", name, loginNames[login])}, nil
		}
		return restartAfter(at, machine, fmt.Sprintf("%s runs on %s by default, from each session's next start.", name, loginNames[login]))
	case command.switches["--api-key"]:
		typed, err := machine.ReadKey()
		if err != nil {
			return nil, err
		}
		key := strings.TrimSpace(typed)
		if key == "" {
			return nil, errors.New("no API key came in: pipe it in, or type it when asked")
		}
		if checked := machine.CheckKey(word, key); !checked.IsTaken {
			return nil, errors.New(checked.Cause + ": nothing was written")
		}
		if err := held.Write(word, key); err != nil {
			return nil, err
		}
		return restartAfter(at, machine, fmt.Sprintf("The vendor took the API key for %s; it is kept on this computer only.", name))
	case command.switches["--remove-key"]:
		wasThere, err := held.Remove(word)
		if err != nil {
			return nil, err
		}
		if !wasThere {
			return []string{fmt.Sprintf("%s holds no API key: nothing to remove.", name)}, nil
		}
		return restartAfter(at, machine, fmt.Sprintf("Removed the API key for %s.", name))
	}
	key, ok := machine.CheckNow(at, word)
	if !ok {
		return nil, errors.New("the model proxy does not run: it runs while the service does and a harness holds a key (aeolus-trierarch start)")
	}
	switch key.State {
	case keys.Ready:
		return []string{fmt.Sprintf("%s's API key is ready: its waiting ships start within a pass.", name)}, nil
	case keys.OutOfCredit:
		return []string{fmt.Sprintf("%s's API key is still out of credit since %s. The proxy checks it again every 15 minutes.", name, key.At)}, nil
	case keys.Refused:
		return []string{fmt.Sprintf("%s's API key was refused by its vendor: give it a new one with aeolus-trierarch login %s --api-key.", name, word)}, nil
	}
	return []string{fmt.Sprintf("%s holds no API key: aeolus-trierarch login %s --api-key.", name, word)}, nil
}

func setShipLogin(at paths.Paths, machine Machine, shipName string, login string) ([]string, error) {
	label := "its harness's default"
	if login != "default" {
		label = loginNames[login]
	}
	isChanged, err := writeLogins(at, func(logins *config.Logins) {
		if login == "default" {
			delete(logins.Ships, shipName)
			return
		}
		if logins.Ships == nil {
			logins.Ships = map[string]string{}
		}
		logins.Ships[shipName] = login
	})
	if err != nil {
		return nil, err
	}
	if !isChanged {
		return []string{fmt.Sprintf("%s runs on %s already.", shipName, label)}, nil
	}
	return restartAfter(at, machine, fmt.Sprintf("%s runs on %s from its next start.", shipName, label))
}

// writeLogins changes the configuration's logins, read as the trierarch reads it, so a broken configuration is said, never written over; answers whether that changed them.
func writeLogins(at paths.Paths, change func(logins *config.Logins)) (bool, error) {
	configuration, err := config.Load(at.Config)
	if err != nil {
		return false, err
	}
	before := config.Logins{}
	if configuration.Logins != nil {
		before = *configuration.Logins
	}
	after := config.Logins{Ships: maps.Clone(before.Ships)}
	if before.Default != nil {
		defaults := *before.Default
		after.Default = &defaults
	}
	change(&after)
	if len(after.Ships) == 0 {
		after.Ships = nil
	}
	if isSameLogins(before, after) {
		return false, nil
	}
	configuration.Logins = &after
	return true, config.Write(at.Config, configuration)
}

func isSameLogins(left config.Logins, right config.Logins) bool {
	var leftDefault, rightDefault config.DefaultLogins
	if left.Default != nil {
		leftDefault = *left.Default
	}
	if right.Default != nil {
		rightDefault = *right.Default
	}
	return leftDefault == rightDefault && maps.Equal(left.Ships, right.Ships)
}

// restartAfter restarts the service once the change is said, so the trierarch reads it; its sessions run on under their holds.
func restartAfter(at paths.Paths, machine Machine, done string) ([]string, error) {
	manager := machine.Service(at)
	status, err := manager.Status()
	if err != nil {
		return nil, err
	}
	if !status.IsInstalled {
		return []string{done, "The service is not installed: run aeolus-trierarch init to run it."}, nil
	}
	if err := manager.Restart(); err != nil {
		return nil, errors.Join(errors.New("changed, but the service did not restart"), err)
	}
	said := []string{done, "The trierarch restarted; its sessions kept running."}
	if !hasSaidItsVersion(manager, at.Running, machine.Sleep) {
		said = append(said, notSaidYet)
	}
	return said, nil
}
