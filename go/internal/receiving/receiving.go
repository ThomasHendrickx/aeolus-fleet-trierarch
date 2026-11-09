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

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/mcpconfiguration"
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

// ConfigurationKeeper applies the MCP configuration the trierarch plugin's ship sent, persisted before it answers.
type ConfigurationKeeper interface {
	Apply(configuration mcpconfiguration.Configuration) (mcpconfiguration.Outcome, error)
}

// Confirmer tells the trierarch plugin's ship, as the trierarch's own ship, that a configuration is persisted.
type Confirmer interface {
	ConfirmMcpConfiguration(pluginShipID string, payload string) error
}

// McpConfiguration is how the loop takes the fleet's MCP configuration: for this trierarch's fleet and plugin ship, opened with its sealing key, kept in File and confirmed to the plugin ship.
type McpConfiguration struct {
	File       ConfigurationKeeper
	Identity   mcpconfiguration.Identity
	SealingKey secrets.Key
	Confirm    Confirmer
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
	// McpConfiguration takes the fleet's MCP configuration; it is handled as any other message without it.
	McpConfiguration *McpConfiguration
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

// takeMcpConfiguration applies the MCP configuration the delivery carries, but only from the trierarch plugin's ship, then confirms it to that ship: a configuration applied before, sealed to the same key, is confirmed again, and an older one is neither applied nor confirmed. One that does not fit is not taken, and the one applied stays; a failure to persist or confirm one is the loop's, so the delivery comes again. What it logs never says a value.
func (l Loop) takeMcpConfiguration(delivery Delivery) error {
	if !l.isFromPlugin(delivery, "an MCP configuration") {
		return nil
	}
	taken := l.McpConfiguration
	configuration, err := mcpconfiguration.Read(delivery.Payload, taken.Identity, taken.SealingKey)
	if err != nil {
		l.Log(fmt.Sprintf("Not handled: an MCP configuration that does not fit (%v). The trierarch keeps the MCP configuration it applied.", err))
		return nil
	}
	outcome, err := taken.File.Apply(configuration)
	if err != nil {
		return err
	}
	if outcome == mcpconfiguration.Older {
		l.Log(fmt.Sprintf("Not handled: MCP configuration version %d, older than the one applied. The trierarch keeps the MCP configuration it applied.", configuration.Version))
		return nil
	}
	return taken.Confirm.ConfirmMcpConfiguration(l.PluginShipID, mcpconfiguration.AppliedPayload(configuration))
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
	if delivery.ContentType == mcpconfiguration.ContentType && l.McpConfiguration != nil {
		if err := l.takeMcpConfiguration(delivery); err != nil {
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
