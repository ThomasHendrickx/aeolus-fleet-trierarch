package receiving

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

const argo = "shp_01m6jyczpnpp5c0vxh54c966cy"

// aShip is the trierarch's own ship: what it is sent to receive, one answer per receive, and what it acknowledged and answered with pong.
type aShip struct {
	cancel  context.CancelFunc
	answers []answer
	acked   []string
	ponged  []string
	ackErr  error
}

type answer struct {
	deliveries []Delivery
	err        error
	// isStop stops the loop as this answer comes.
	isStop bool
}

// Receive answers the next answer; once they are all given it stops the loop.
func (s *aShip) Receive(ctx context.Context) ([]Delivery, error) {
	if len(s.answers) == 0 {
		s.cancel()
		return nil, ctx.Err()
	}
	next := s.answers[0]
	s.answers = s.answers[1:]
	if next.isStop {
		s.cancel()
	}
	return next.deliveries, next.err
}

func (s *aShip) Ack(deliveryID string) error {
	s.acked = append(s.acked, deliveryID)
	return s.ackErr
}

func (s *aShip) Pong(deliveryID string) error {
	s.ponged = append(s.ponged, deliveryID)
	return nil
}

type aRun struct {
	ship    *aShip
	logged  []string
	waits   []time.Duration
	cutOffs []bool
}

// runWith runs the loop until the ship has given every answer.
func runWith(answers ...answer) *aRun {
	ctx, cancel := context.WithCancel(context.Background())
	ran := &aRun{ship: &aShip{cancel: cancel, answers: answers}}
	Loop{
		Ship:        ran.ship,
		Log:         func(line string) { ran.logged = append(ran.logged, line) },
		Interval:    5 * time.Second,
		KeyWaitMax:  300 * time.Second,
		Pause:       func(_ context.Context, wait time.Duration) { ran.waits = append(ran.waits, wait) },
		OnKeyCutOff: func(isCutOff bool) { ran.cutOffs = append(ran.cutOffs, isCutOff) },
	}.Run(ctx)
	return ran
}

func a(contentType string, id string) Delivery {
	return Delivery{DeliveryID: id, SenderShipID: argo, ContentType: contentType}
}

func aKeyCutOff() answer {
	return answer{err: &Refusal{Code: "KEY_UNAVAILABLE", Message: "the key cannot be had"}}
}

func TestAPingGetsPongAndIsNotAcknowledged(t *testing.T) {
	ran := runWith(answer{deliveries: []Delivery{a("application/vnd.aeolus.ping", "d1")}})

	if !slices.Equal(ran.ship.ponged, []string{"d1"}) || len(ran.ship.acked) != 0 {
		t.Fatalf("ponged %v, acked %v", ran.ship.ponged, ran.ship.acked)
	}
}

func TestAPingIsToldByItsMediaTypeWithoutCaseAndParameters(t *testing.T) {
	ran := runWith(answer{deliveries: []Delivery{a(" Application/Vnd.Aeolus.Ping ; charset=utf-8", "d1")}})

	if !slices.Equal(ran.ship.ponged, []string{"d1"}) {
		t.Fatalf("ponged %v", ran.ship.ponged)
	}
}

func TestAnyOtherDeliveryIsAcknowledgedAndLoggedAsNotHandled(t *testing.T) {
	ran := runWith(answer{deliveries: []Delivery{a("text/markdown", "d1"), a("text/plain", "d2")}})

	if !slices.Equal(ran.ship.acked, []string{"d1", "d2"}) || len(ran.ship.ponged) != 0 {
		t.Fatalf("acked %v, ponged %v", ran.ship.acked, ran.ship.ponged)
	}
	want := "Not handled: text/markdown from " + argo + ". A trierarch takes work only through the crew requests assigned to it."
	if ran.logged[0] != want {
		t.Fatalf("logged %q", ran.logged)
	}
}

func TestAFailureIsLoggedAndTheLoopWaitsAnIntervalAndGoesOn(t *testing.T) {
	ran := runWith(answer{err: errors.New("the fleet at http://f cannot be reached")}, answer{deliveries: []Delivery{a("text/markdown", "d1")}})

	if ran.logged[0] != "The loop failed and goes on: the fleet at http://f cannot be reached" || !slices.Equal(ran.waits, []time.Duration{5 * time.Second}) {
		t.Fatalf("logged %q, waited %v", ran.logged, ran.waits)
	}
	if !slices.Equal(ran.ship.acked, []string{"d1"}) {
		t.Fatalf("acked %v", ran.ship.acked)
	}
}

func TestAFailedAcknowledgementIsAFailureOfTheLoop(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	ship := &aShip{cancel: cancel, answers: []answer{{deliveries: []Delivery{a("text/markdown", "d1")}}}, ackErr: errors.New("ack refused")}
	logged := []string{}

	Loop{Ship: ship, Log: func(line string) { logged = append(logged, line) }, Interval: time.Second, KeyWaitMax: time.Minute, Pause: func(context.Context, time.Duration) {}}.Run(ctx)

	if !slices.Contains(logged, "The loop failed and goes on: ack refused") {
		t.Fatalf("logged %q", logged)
	}
}

func TestWhileTheKeyIsCutOffTheWaitDoublesUpToTheMaximumAndItIsSaidOnce(t *testing.T) {
	answers := []answer{}
	for range 9 {
		answers = append(answers, aKeyCutOff())
	}

	ran := runWith(answers...)

	want := []time.Duration{5, 10, 20, 40, 80, 160, 300, 300, 300}
	for i := range want {
		want[i] *= time.Second
	}
	if !slices.Equal(ran.waits, want) {
		t.Fatalf("waited %v", ran.waits)
	}
	if !slices.Equal(ran.cutOffs, []bool{true}) {
		t.Fatalf("told %v", ran.cutOffs)
	}
	said := 0
	for _, line := range ran.logged {
		if strings.HasPrefix(line, "The fleet's key is not reachable, so the trierarch's own ship receives nothing and waits, longer each time, up to 300000 ms: the key cannot be had") {
			said++
		}
	}
	if said != 1 || len(ran.logged) != 1 {
		t.Fatalf("logged %q", ran.logged)
	}
}

func TestWhenTheKeyIsBackItIsSaidAndTheNextCutOffStartsAtAnInterval(t *testing.T) {
	ran := runWith(aKeyCutOff(), aKeyCutOff(), answer{}, aKeyCutOff())

	if !slices.Equal(ran.waits, []time.Duration{5 * time.Second, 10 * time.Second, 5 * time.Second}) {
		t.Fatalf("waited %v", ran.waits)
	}
	if !slices.Equal(ran.cutOffs, []bool{true, false, true}) {
		t.Fatalf("told %v", ran.cutOffs)
	}
	if !slices.Contains(ran.logged, "The fleet's key is reachable again: the trierarch's own ship receives again") {
		t.Fatalf("logged %q", ran.logged)
	}
}

func TestAFailureThatComesWithTheStopIsNotLoggedAndEndsTheLoop(t *testing.T) {
	ran := runWith(answer{err: errors.New("context canceled"), isStop: true})

	if len(ran.logged) != 0 || len(ran.waits) != 0 {
		t.Fatalf("logged %q, waited %v", ran.logged, ran.waits)
	}
}
