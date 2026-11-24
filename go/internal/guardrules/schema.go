package guardrules

import (
	"encoding/json"
	"path"
	"regexp"
	"slices"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/crew"
)

// These in-memory schemas mirror guard design section 4.1 and the section
// 4.4 message. Common's guard-rules.ts contract is not published yet.
type schema func(json.RawMessage) bool

func object(properties map[string]schema, required ...string) schema {
	return func(raw json.RawMessage) bool {
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) != nil || fields == nil {
			return false
		}
		for _, name := range required {
			if _, ok := fields[name]; !ok {
				return false
			}
		}
		for name, value := range fields {
			check, ok := properties[name]
			if !ok || !check(value) {
				return false
			}
		}
		return true
	}
}

func array(item schema) schema {
	return func(raw json.RawMessage) bool {
		var items []json.RawMessage
		if json.Unmarshal(raw, &items) != nil || items == nil {
			return false
		}
		for _, value := range items {
			if !item(value) {
				return false
			}
		}
		return true
	}
}

func text(check func(string) bool) schema {
	return func(raw json.RawMessage) bool {
		var value *string
		return json.Unmarshal(raw, &value) == nil && value != nil && check(*value)
	}
}

func oneOf(values ...string) schema {
	return text(func(value string) bool { return slices.Contains(values, value) })
}

var (
	nonempty    = text(func(value string) bool { return value != "" })
	literal     = text(func(string) bool { return true })
	namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
	name        = text(func(value string) bool { return len(value) <= 100 && namePattern.MatchString(value) })
	command     = object(map[string]schema{"command": nonempty, "args": array(literal)}, "command")
	commands    = object(map[string]schema{"allow": array(command), "deny": array(command)})
	git         = object(map[string]schema{"deny": array(oneOf("push", "force-push", "skip-hooks", "rewrite-history", "delete-branch", "change-remote", "change-config"))})
	writePath   = text(func(value string) bool {
		return value != "" && !path.IsAbs(value) && !slices.Contains(strings.Split(value, "/"), "..")
	})
	writePaths = object(map[string]schema{"allow": array(writePath), "deny": array(writePath)})
	tool       = text(func(value string) bool {
		if slices.Contains([]string{"shell", "file-write", "file-read", "web", "agent"}, value) {
			return true
		}
		mcp, ok := strings.CutPrefix(value, "mcp:")
		server, tool, hasSlash := strings.Cut(mcp, "/")
		return ok && hasSlash && server != "" && tool != "" && !strings.Contains(tool, "/")
	})
	tools       = object(map[string]schema{"allow": array(tool), "deny": array(tool)})
	rules       = object(map[string]schema{"commands": commands, "git": git, "writePaths": writePaths, "tools": tools})
	resolvedSet = object(map[string]schema{
		"name": name, "repository": nonempty, "commit": nonempty, "file": nonempty,
		"floor": func(raw json.RawMessage) bool {
			var value *bool
			return json.Unmarshal(raw, &value) == nil && value != nil
		},
		"rules": rules,
	}, "name", "repository", "commit", "file", "floor", "rules")
	messageSchema = object(map[string]schema{
		"fleetId": nonempty, "pluginShipId": nonempty, "shipId": text(crew.IsShipID),
		"settingsVersion": func(raw json.RawMessage) bool { var value int; return json.Unmarshal(raw, &value) == nil && value >= 1 },
		"sets":            array(resolvedSet),
	}, "fleetId", "pluginShipId", "shipId", "settingsVersion", "sets")
)
