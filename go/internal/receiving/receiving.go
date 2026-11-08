// Package receiving is what the trierarch's own ship does beside the passes
// (docs/trierarch.md): it receives what is sent to it, answers a ping with
// pong and acknowledges anything else, which it takes no work from.
package receiving

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/aip"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpservers"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/secrets"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/trusted"
)

// pingContentType is the reserved content type only the fleet's ping call sends.
const pingContentType = "application/vnd.aeolus.ping"

// keyUnavailable is the refusal the fleet answers while the company's key cannot be had: nothing was claimed, and a later call may pass (decision 0068).
const keyUnavailable = "KEY_UNAVAILABLE"

// Delivery is one message that came to the trierarch's own ship.
type Delivery struct {
	DeliveryID   string
	SenderShipID string
	ContentType  string
	Payload      string
}

// Keeper keeps the trusted repositories the trierarch plugin's ship sent.
type Keeper interface {
	Accept(list []trusted.Repository) error
}

// ServerKeeper keeps the MCP servers the trierarch plugin's ship sent.
type ServerKeeper interface {
	Accept(list []mcpservers.Server) error
}

// AipKeeper keeps the aip setting the trierarch plugin's ship sent with the MCP servers, none when the list carried none.
type AipKeeper interface {
	Accept(setting *aip.Setting) error
}

// SecretKeeper keeps the secrets the trierarch plugin's ship sent, opened.
type SecretKeeper interface {
	Accept(held map[string]string) error
}

// Refusal is the fleet's own refusal: its code and its message.
type Refusal struct {
	Code    string
	Message string
}

func (r *Refusal) Error() string {
	return r.Code + ": " + r.Message
}

// Ship is the trierarch's own ship at the fleet.
type Ship interface {
	// Receive waits for deliveries as long as the fleet holds the call, or until ctx ends.
	Receive(ctx context.Context) ([]Delivery, error)
	Ack(deliveryID string) error
	Pong(deliveryID string) error
}

// Loop receives and handles what comes until ctx ends. A failure is logged and the loop waits an interval before it goes on. While the fleet's key is cut off a receive waits longer after each refusal, up to KeyWaitMax, says so once and says when the key is back: the trierarch's own ship is never taken as dead for it.
type Loop struct {
	Ship       Ship
	Log        func(line string)
	Interval   time.Duration
	KeyWaitMax time.Duration
	// Pause waits, ending at once when ctx ends.
	Pause func(ctx context.Context, wait time.Duration)
	// PluginShipID is the trierarch plugin's ship, the one ship the trusted repositories are taken from; empty on a machine that does not know it.
	PluginShipID string
	// Trusted keeps the trusted repositories; the list is handled as any other message without it.
	Trusted Keeper
	// McpServers keeps the MCP servers; the list is handled as any other message without it.
	McpServers ServerKeeper
	// Aip keeps the aip setting the MCP server list carries; it is not taken without it.
	Aip AipKeeper
	// Secrets keeps the secrets, opened with SealingKey; they are handled as any other message without it.
	Secrets    SecretKeeper
	SealingKey secrets.Key
	// OnKeyCutOff is told at the first refusal (true) and when a receive passes again (false).
	OnKeyCutOff func(isCutOff bool)
}

// IsPing says whether a content type is the ping's: media types compare without case and without their parameters (RFC 9110), so no spelling of it slips past.
func IsPing(contentType string) bool {
	essence, _, _ := strings.Cut(contentType, ";")
	return strings.ToLower(strings.TrimSpace(essence)) == pingContentType
}

// isFromPlugin says whether the delivery comes from the trierarch plugin's ship init kept, the one ship a list is taken from: a sender's type is any ship's to pick, so no other ship can make the machine clone a repository or call a server. Otherwise it logs why the delivery is not handled, naming what it carried.
func (l Loop) isFromPlugin(delivery Delivery, carried string) bool {
	from := fmt.Sprintf("Not handled: %s from %s.", carried, delivery.SenderShipID)
	if l.PluginShipID == "" {
		l.Log(from + " This machine does not know the trierarch plugin's ship: run aeolus-trierarch init --plugin-ship-id <its ship id>.")
		return false
	}
	if delivery.SenderShipID != l.PluginShipID {
		l.Log(fmt.Sprintf("%s The trierarch takes them only from the trierarch plugin's ship %s.", from, l.PluginShipID))
		return false
	}
	return true
}

// takeTrusted takes the trusted repositories the delivery carries, but only from the trierarch plugin's ship. A list that does not fit is not taken, and the one held stays; a failure to keep a list that fits is the loop's, so the delivery comes again.
func (l Loop) takeTrusted(delivery Delivery) error {
	if !l.isFromPlugin(delivery, "trusted repositories") {
		return nil
	}
	list, err := trusted.Read(delivery.Payload)
	if err != nil {
		l.Log(fmt.Sprintf("Not handled: trusted repositories that do not fit (%v). The trierarch keeps the list it holds.", err))
		return nil
	}
	return l.Trusted.Accept(list)
}

// takeMcpServers takes the MCP servers the delivery carries, and the aip setting with them, as takeTrusted takes the trusted repositories: a list whose aip does not fit is not taken either, and a list with no aip clears the one held.
func (l Loop) takeMcpServers(delivery Delivery) error {
	if !l.isFromPlugin(delivery, "MCP servers") {
		return nil
	}
	list, err := mcpservers.Read(delivery.Payload)
	if err != nil {
		l.Log(fmt.Sprintf("Not handled: MCP servers that do not fit (%v). The trierarch keeps the list it holds.", err))
		return nil
	}
	setting, err := aip.InList(delivery.Payload)
	if err != nil {
		l.Log(fmt.Sprintf("Not handled: MCP servers whose aip does not fit (%v). The trierarch keeps the list it holds.", err))
		return nil
	}
	if err := l.McpServers.Accept(list); err != nil {
		return err
	}
	if l.Aip == nil {
		return nil
	}
	return l.Aip.Accept(setting)
}

// takeSecrets takes the secrets the delivery carries, as takeTrusted takes the trusted repositories; what it logs never says a value.
func (l Loop) takeSecrets(delivery Delivery) error {
	if !l.isFromPlugin(delivery, "secrets") {
		return nil
	}
	held, err := secrets.Read(delivery.Payload, l.SealingKey)
	if err != nil {
		l.Log(fmt.Sprintf("Not handled: secrets that do not fit (%v). The trierarch keeps the secrets it holds.", err))
		return nil
	}
	return l.Secrets.Accept(held)
}

func (l Loop) handle(delivery Delivery) error {
	if IsPing(delivery.ContentType) {
		return l.Ship.Pong(delivery.DeliveryID)
	}
	if delivery.ContentType == trusted.ListContentType && l.Trusted != nil {
		if err := l.takeTrusted(delivery); err != nil {
			return err
		}
		return l.Ship.Ack(delivery.DeliveryID)
	}
	if delivery.ContentType == mcpservers.ListContentType && l.McpServers != nil {
		if err := l.takeMcpServers(delivery); err != nil {
			return err
		}
		return l.Ship.Ack(delivery.DeliveryID)
	}
	if delivery.ContentType == secrets.ContentType && l.Secrets != nil {
		if err := l.takeSecrets(delivery); err != nil {
			return err
		}
		return l.Ship.Ack(delivery.DeliveryID)
	}
	if err := l.Ship.Ack(delivery.DeliveryID); err != nil {
		return err
	}
	l.Log(fmt.Sprintf("Not handled: %s from %s. A trierarch takes work only through the crew requests assigned to it.", delivery.ContentType, delivery.SenderShipID))
	return nil
}

func (l Loop) step(ctx context.Context) error {
	deliveries, err := l.Ship.Receive(ctx)
	if err != nil {
		return err
	}
	for _, delivery := range deliveries {
		if err := l.handle(delivery); err != nil {
			return err
		}
	}
	return nil
}

// Run receives and handles until ctx ends.
func (l Loop) Run(ctx context.Context) {
	// How long the next wait is while the key is cut off; zero while it is not.
	var keyWait time.Duration
	told := func(isCutOff bool) {
		if l.OnKeyCutOff != nil {
			l.OnKeyCutOff(isCutOff)
		}
	}
	for ctx.Err() == nil {
		err := l.step(ctx)
		if err == nil {
			if keyWait != 0 {
				keyWait = 0
				told(false)
				l.Log("The fleet's key is reachable again: the trierarch's own ship receives again")
			}
			continue
		}
		if ctx.Err() != nil {
			return
		}
		var refusal *Refusal
		if errors.As(err, &refusal) && refusal.Code == keyUnavailable {
			if keyWait == 0 {
				told(true)
				l.Log(fmt.Sprintf("The fleet's key is not reachable, so the trierarch's own ship receives nothing and waits, longer each time, up to %d ms: %s", l.KeyWaitMax.Milliseconds(), refusal.Message))
				keyWait = l.Interval
			} else {
				keyWait = min(keyWait*2, l.KeyWaitMax)
			}
			l.Pause(ctx, keyWait)
			continue
		}
		l.Log("The loop failed and goes on: " + err.Error())
		l.Pause(ctx, l.Interval)
	}
}
