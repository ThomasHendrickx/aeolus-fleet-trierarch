package permissions

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
)

// QuestionSession locates a running Claude Code session's plugin and model.
type QuestionSession struct {
	Plugin              plugin.Plugin
	Folder, Name, Model string
}

// PluginQuestions uses only the plugin's scripts to ask, read context and withdraw.
type PluginQuestions struct {
	Session func(string) (QuestionSession, error)
	pending sync.Map
}

// Ask includes the handed task and the tool's whole input up to 4 KB.
func (p *PluginQuestions) Ask(ctx context.Context, ship string, request Request) (string, error) {
	session, err := p.Session(ship)
	if err != nil {
		return "", err
	}
	task, err := session.Plugin.PermissionContext(ctx, session.Folder)
	if err != nil {
		return "", err
	}
	var delivery struct {
		MessageID string `json:"messageId"`
		Sender    string `json:"senderName"`
		Payload   string `json:"payload"`
	}
	if err = json.Unmarshal([]byte(task), &delivery); err != nil {
		return "", fmt.Errorf("read permission task: %w", err)
	}
	contextText := "Ship: " + session.Name + " (" + ship + ")\n"
	if delivery.MessageID == "" {
		contextText += "No task message handed.\n"
	} else {
		contextText += "Task: " + delivery.MessageID + " from " + delivery.Sender + "\n" + cutText(delivery.Payload, 1024) + "\n"
	}
	contextText += "Tool: " + request.Tool + "\nInput:\n" + cutText(string(request.Input), 4096)
	id, err := session.Plugin.AskQuestion(ctx, session.Folder, plugin.Question{Title: request.ActionTitle(), Context: contextText, Rule: request.rule(), Model: session.Model})
	if id != "" {
		p.pending.Store(id, session)
	}
	return id, err
}

// Withdraw addresses the original question through the plugin's remembered recipient.
func (p *PluginQuestions) Withdraw(ctx context.Context, ship, id string) error {
	value, ok := p.pending.LoadAndDelete(id)
	if !ok {
		return fmt.Errorf("permission question is not open")
	}
	session, ok := value.(QuestionSession)
	if !ok {
		return fmt.Errorf("permission question has no session")
	}
	return session.Plugin.WithdrawQuestion(ctx, session.Folder, id, session.Model)
}

func cutText(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	end := limit
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end] + fmt.Sprintf("\n[%d bytes cut]", len(text)-end)
}

func (r Request) action() string {
	var input struct {
		Command  string `json:"command"`
		Path     string `json:"file_path"`
		Notebook string `json:"notebook_path"`
	}
	_ = json.Unmarshal(r.Input, &input)
	if r.Tool == "Bash" {
		return input.Command
	}
	switch r.Tool {
	case "NotebookEdit":
		return input.Notebook
	case "Read", "Write", "Edit", "MultiEdit":
		return input.Path
	}
	return ""
}

// ActionTitle names the tool and concrete action for the owner and report.
func (r Request) ActionTitle() string {
	action := r.action()
	if action != "" {
		if r.Tool == "Bash" {
			return "Run `" + action + "`"
		}
		return r.Tool + " `" + action + "`"
	}
	if r.Title != "" {
		return r.Title
	}
	if r.Tool != "" {
		return r.Tool
	}
	return "Permission"
}
func (r Request) rule() string {
	if action := r.action(); action != "" {
		return r.Tool + "(" + action + ")"
	}
	return strings.TrimSpace(r.Tool)
}
