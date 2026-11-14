package permissions

import (
	"context"
	"fmt"
	"time"
)

// Reply is an answer still in the plugin's store, not handed to the session.
type Reply struct {
	Answer
	DeliveryID, SenderID, SenderName string
	Matches                          bool
}

// Answers reads and finishes replies through the plugin's store only.
type Answers interface {
	Receive(context.Context, string, string) (Reply, error)
	Finish(context.Context, string, Reply, bool) error
}

type receivedAnswer struct {
	reply Reply
	err   error
}

func (s Service) waitAnswer(ctx context.Context, ship string, request Request, answers Answers, asked Owner, question *string, answered *bool) Decision {
	timer := s.Clock.NewTimer(waitLimit)
	defer timer.Stop()
	for {
		reply, end := receiveAnswer(ctx, timer, answers, ship, *question)
		if end != nil {
			return *end
		}
		owner, err := s.Owners.Owner(ctx, ship)
		take := err == nil && owner.IsPerson && owner.ID != "" && owner.ID == reply.SenderID && reply.Matches
		if err != nil {
			s.logFailure(err)
		}
		// An owner lookup may have waited past the limit or a cancellation.
		select {
		case <-ctx.Done():
			return Decision{Behavior: "deny", Message: "permission call cancelled"}
		case <-timer.Done():
			return Decision{Behavior: "deny", Message: "not answered in 30 minutes; the question was withdrawn"}
		default:
		}
		if err := answers.Finish(ctx, ship, reply, take); err != nil {
			s.logFailure(err)
			continue
		}
		if take {
			*answered = true
			return request.decision(reply.Answer)
		}
		s.logFailure(fmt.Errorf("answer from %s (%s) left for ordinary hand-over", reply.SenderName, reply.SenderID))
		if reply.Matches && reply.SenderID == asked.ID && err == nil && owner.ID != asked.ID && owner.IsPerson {
			if err := s.Questions.Withdraw(context.WithoutCancel(ctx), ship, *question); err != nil {
				s.logFailure(err)
			}
			id, err := s.Questions.Ask(context.WithoutCancel(ctx), ship, request)
			*question = id
			if err != nil {
				s.logFailure(err)
				return Decision{Behavior: "deny", Message: "could not ask"}
			}
			asked = owner
		}
	}
}

func receiveAnswer(ctx context.Context, timer Timer, answers Answers, ship, question string) (Reply, *Decision) {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	result := make(chan receivedAnswer, 1)
	go func() {
		defer close(done)
		reply, err := answers.Receive(ctx, ship, question)
		result <- receivedAnswer{reply, err}
	}()
	defer func() { cancel(); <-done }()
	for {
		select {
		case <-ctx.Done():
			return Reply{}, &Decision{Behavior: "deny", Message: "permission call cancelled"}
		case <-timer.Done():
			return Reply{}, &Decision{Behavior: "deny", Message: "not answered in 30 minutes; the question was withdrawn"}
		case got := <-result:
			if got.err == nil {
				return got.reply, nil
			}
			// The adapter retries transient fleet failures within Receive. Other
			// failures cannot safely identify an answer and must fail closed.
			return Reply{}, &Decision{Behavior: "deny", Message: "could not read the permission answer"}
		}
	}
}

// waitForReply backs off empty receives without a process-owned ticker.
func waitForReply(ctx context.Context) error {
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
