package permissions

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

type failingAnswers struct {
	answerQuestions
	failed atomic.Bool
}

func (q *failingAnswers) Receive(ctx context.Context, ship, id string) (Reply, error) {
	if !q.failed.Swap(true) {
		return Reply{}, errors.New("fleet is unreachable")
	}
	return q.answerQuestions.Receive(ctx, ship, id)
}

func TestAFailedAnswerReadIsLoggedAndKeepsWaitingWithinTheOriginalLimit(t *testing.T) {
	for _, end := range []string{"owner answers", "limit"} {
		t.Run(end, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				q := &failingAnswers{answerQuestions: answerQuestions{incoming: make(chan Reply, 1)}}
				var logs []string
				service := Service{Owners: &currentOwner{id: "owner"}, Questions: q, Reports: &reports{}, Clock: SystemClock{}, Log: func(s string) { logs = append(logs, s) }}
				result := make(chan Decision, 1)
				go func() { result <- service.Ask(context.Background(), "scout", Request{Tool: "Bash"}) }()
				synctest.Wait()
				select {
				case got := <-result:
					t.Fatalf("failed read ended wait: %+v", got)
				default:
				}
				if len(logs) != 1 || !strings.Contains(logs[0], "fleet is unreachable") {
					t.Fatalf("failure log = %v", logs)
				}
				if end == "owner answers" {
					time.Sleep(time.Second)
					q.incoming <- Reply{Answer: Answer{Option: 1}, Matches: true, SenderID: "owner"}
					if got := <-result; got.Behavior != "allow" {
						t.Fatalf("answer after failed read = %+v", got)
					}
				} else {
					time.Sleep(30 * time.Minute)
					if got := <-result; got.Message != "not answered in 30 minutes; the question was withdrawn" {
						t.Fatalf("limit after failed read = %+v", got)
					}
				}
			})
		})
	}
}

type changedToArgo struct{ isArgo atomic.Bool }

func (o *changedToArgo) Owner(context.Context, string) (Owner, error) {
	if o.isArgo.Load() {
		return Owner{}, nil
	}
	return Owner{ID: "owner", IsPerson: true}, nil
}

func TestAFormerOwnersAnswerAfterArgoTakesOwnershipIsKeptAndDeniesWithoutAskingArgo(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := &answerQuestions{incoming: make(chan Reply, 1)}
		owner := &changedToArgo{}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		service := Service{Owners: owner, Questions: q, Reports: &reports{}, Clock: SystemClock{}}
		result := make(chan Decision, 1)
		go func() { result <- service.Ask(ctx, "scout", Request{Tool: "Bash"}) }()
		synctest.Wait()
		owner.isArgo.Store(true)
		q.incoming <- Reply{Answer: Answer{Option: 1}, Matches: true, SenderID: "owner", SenderName: "former owner"}
		synctest.Wait()
		select {
		case got := <-result:
			if got.Message != "this ship's owner is argo: nobody is asked" || len(q.kept) != 1 || len(q.taken) != 0 || q.asked.Load() != 1 || q.withdrawn.Load() != 1 {
				t.Fatalf("decision %+v kept %d taken %d asks %d withdrawals %d", got, len(q.kept), len(q.taken), q.asked.Load(), q.withdrawn.Load())
			}
		default:
			t.Fatal("former owner's reply left the argo-owned ship waiting")
		}
	})
}
