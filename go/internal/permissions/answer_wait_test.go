package permissions

import (
	"context"
	"encoding/json"
	"testing"
	"testing/synctest"
	"time"
)

type answerQuestions struct {
	questions
	incoming    chan Reply
	kept, taken []Reply
}

func (q *answerQuestions) Receive(ctx context.Context, _, _ string) (Reply, error) {
	select {
	case r := <-q.incoming:
		return r, nil
	case <-ctx.Done():
		return Reply{}, ctx.Err()
	}
}
func (q *answerQuestions) Finish(_ context.Context, _ string, r Reply, take bool) error {
	if take {
		q.taken = append(q.taken, r)
	} else {
		q.kept = append(q.kept, r)
	}
	return nil
}

type currentOwner struct{ id string }

func (o *currentOwner) Owner(context.Context, string) (Owner, error) {
	return Owner{ID: o.id, IsPerson: true}, nil
}

func TestOnlyTheCurrentOwnersMatchingAnswerEndsTheWait(t *testing.T) {
	for _, rejected := range []string{"another ship", "former owner", "withdrawn question", "not a reply"} {
		t.Run(rejected, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				q := &answerQuestions{incoming: make(chan Reply, 3)}
				owner := &currentOwner{id: "owner"}
				service := Service{Owners: owner, Questions: q, Reports: &reports{}, Clock: SystemClock{}}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				result := make(chan Decision, 1)
				go func() {
					result <- service.Ask(ctx, "scout", Request{Tool: "Bash", Input: json.RawMessage(`{"command":"npm ci"}`)})
				}()
				synctest.Wait()
				wrong := Reply{Answer: Answer{Option: 1}, SenderID: "other", SenderName: "other", Matches: true}
				if rejected == "former owner" {
					owner.id = "new-owner"
					wrong.SenderID = "owner"
				}
				if rejected == "withdrawn question" || rejected == "not a reply" {
					wrong.SenderID = owner.id
					wrong.Matches = false
				}
				q.incoming <- wrong
				synctest.Wait()
				select {
				case got := <-result:
					t.Fatalf("rejected answer ended wait: %+v", got)
				default:
				}
				if len(q.kept) != 1 || len(q.taken) != 0 {
					t.Fatalf("kept %d, taken %d", len(q.kept), len(q.taken))
				}
				q.incoming <- Reply{Answer: Answer{Option: 1}, SenderID: owner.id, SenderName: "person", Matches: true}
				got := <-result
				if got.Behavior != "allow" || string(got.UpdatedInput) != `{"command":"npm ci"}` || len(q.taken) != 1 {
					t.Fatalf("result %+v, taken %d", got, len(q.taken))
				}
			})
		})
	}
}

func TestAFormerOwnersAnswerReasksTheCurrentOwnerForOnlyTheTimeLeft(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := &answerQuestions{incoming: make(chan Reply, 1)}
		owner := &currentOwner{id: "owner"}
		service := Service{Owners: owner, Questions: q, Reports: &reports{}, Clock: SystemClock{}}
		result := make(chan Decision, 1)
		go func() {
			result <- service.Ask(context.Background(), "scout", Request{Tool: "Bash", Input: json.RawMessage(`{"command":"npm ci"}`)})
		}()
		synctest.Wait()
		time.Sleep(29 * time.Minute)
		owner.id = "new-owner"
		q.incoming <- Reply{Answer: Answer{Option: 1}, SenderID: "owner", SenderName: "former", Matches: true}
		synctest.Wait()
		if q.asked.Load() != 2 || q.withdrawn.Load() != 1 {
			t.Fatalf("asks %d, withdrawals %d", q.asked.Load(), q.withdrawn.Load())
		}
		time.Sleep(time.Minute)
		got := <-result
		if got.Message != "not answered in 30 minutes; the question was withdrawn" || q.withdrawn.Load() != 2 {
			t.Fatalf("decision %+v, withdrawals %d", got, q.withdrawn.Load())
		}
	})
}
