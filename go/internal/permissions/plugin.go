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
	locksMu sync.Mutex
	locks   map[string]*sync.Mutex
}

// Ask includes the handed task and the tool's whole input up to 4 KB.
func (p *PluginQuestions) Ask(ctx context.Context, ship string, request Request) (string, error) {
	unlock := p.lock(ship)
	defer unlock()
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
	id, message, err := session.Plugin.AskQuestion(ctx, session.Folder, plugin.Question{Title: request.ActionTitle(), Context: contextText, Rule: request.rule(), Model: session.Model})
	if id != "" {
		p.pending.Store(id, pendingQuestion{QuestionSession: session, MessageID: message})
	}
	return id, err
}

// Withdraw addresses the original question through the plugin's remembered recipient.
func (p *PluginQuestions) Withdraw(ctx context.Context, ship, id string) error {
	unlock := p.lock(ship)
	defer unlock()
	value, ok := p.pending.LoadAndDelete(id)
	if !ok {
		return fmt.Errorf("permission question is not open")
	}
	session, ok := value.(pendingQuestion)
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
	if action := r.sessionRule(); action != "" {
		return r.ruleTool() + "(" + action + ")"
	}
	return strings.TrimSpace(r.Tool)
}

type pendingQuestion struct {
	QuestionSession
	MessageID string
}

// Receive reads replies before ordinary hand-over, matching both reply and question ids.
func (p *PluginQuestions) Receive(ctx context.Context, ship, id string) (Reply, error) {
	value, ok := p.pending.Load(id)
	if !ok {
		return Reply{}, fmt.Errorf("permission question is not open")
	}
	question, ok := value.(pendingQuestion)
	if !ok {
		return Reply{}, fmt.Errorf("permission question has no session")
	}
	for {
		text, err := p.receive(ctx, ship, id, question)
		if ctx.Err() != nil {
			return Reply{}, ctx.Err()
		}
		if err != nil {
			return Reply{}, err
		}
		var delivery struct{ DeliveryID, SenderShipID, SenderName, InReplyTo, Payload string }
		if err := json.Unmarshal([]byte(text), &delivery); err != nil {
			return Reply{}, fmt.Errorf("read permission answer: %w", err)
		}
		if delivery.DeliveryID == "" {
			if err := waitForReply(ctx); err != nil {
				return Reply{}, err
			}
			continue
		}
		reply := Reply{DeliveryID: delivery.DeliveryID, SenderID: delivery.SenderShipID, SenderName: delivery.SenderName}
		err = json.Unmarshal([]byte(delivery.Payload), &reply.Answer)
		valid := reply.Option >= 1 && reply.Option <= 3 || reply.Option == 0 && reply.Note != ""
		reply.Matches = err == nil && valid && reply.QuestionID == id && question.MessageID != "" && delivery.InReplyTo == question.MessageID
		return reply, nil
	}
}

// Finish acknowledges every answer, consuming only the current owner's matching reply.
func (p *PluginQuestions) Finish(ctx context.Context, ship string, reply Reply, take bool) error {
	unlock := p.lock(ship)
	defer unlock()
	session, err := p.Session(ship)
	if err != nil {
		return err
	}
	if err := session.Plugin.FinishPermissionReply(ctx, session.Folder, reply.DeliveryID, take); err != nil {
		return err
	}
	if take {
		p.pending.Delete(reply.QuestionID)
	}
	return nil
}

// Script calls for one ship share its store; different ships never share a lock.
func (p *PluginQuestions) lock(ship string) func() {
	p.locksMu.Lock()
	if p.locks == nil {
		p.locks = make(map[string]*sync.Mutex)
	}
	lock := p.locks[ship]
	if lock == nil {
		lock = &sync.Mutex{}
		p.locks[ship] = lock
	}
	p.locksMu.Unlock()
	lock.Lock()
	return lock.Unlock
}

func (p *PluginQuestions) receive(ctx context.Context, ship, id string, question pendingQuestion) (string, error) {
	unlock := p.lock(ship)
	defer unlock()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	var others []string
	p.pending.Range(func(key, value any) bool {
		other, ok := value.(pendingQuestion)
		otherID, isID := key.(string)
		if ok && isID && otherID != id && other.Folder == question.Folder {
			others = append(others, otherID)
		}
		return true
	})
	return question.Plugin.PermissionReply(ctx, question.Folder, others...)
}
