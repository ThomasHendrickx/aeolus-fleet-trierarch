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
	// OnKeyCutOff is told at the first refusal (true) and when a receive passes again (false).
	OnKeyCutOff func(isCutOff bool)
}

// IsPing says whether a content type is the ping's: media types compare without case and without their parameters (RFC 9110), so no spelling of it slips past.
func IsPing(contentType string) bool {
	essence, _, _ := strings.Cut(contentType, ";")
	return strings.ToLower(strings.TrimSpace(essence)) == pingContentType
}

func (l Loop) handle(delivery Delivery) error {
	if IsPing(delivery.ContentType) {
		return l.Ship.Pong(delivery.DeliveryID)
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
