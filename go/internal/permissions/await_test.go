package permissions

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestPrivateWaitReportsAsItsShipAndRestoresWhenTheConnectionCloses(t *testing.T) {
	for _, end := range []string{"proxy connection closes", "trierarch channel closes"} {
		t.Run(end, func(t *testing.T) {
			var mu sync.Mutex
			current := Report{State: "working", Note: "building", Revision: "before"}
			writes := 0
			waiting, restored := make(chan struct{}), make(chan struct{})
			fleet := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				if r.Header.Get("Authorization") != "Bearer crew-for-test" {
					t.Error("fleet request did not use the ship crew")
				}
				switch r.URL.Path {
				case "/api/v1/ship/whoami":
					fmt.Fprint(w, `{"ownerShipId":"shp_01m6jyczpnpp5c0vxh54c966cz","ownerName":"thomas"}`)
				case "/api/v1/ship/reportLog":
					_ = json.NewEncoder(w).Encode(map[string]any{"report": current})
				case "/api/v1/ship/report":
					data, err := io.ReadAll(r.Body)
					if err != nil {
						t.Error(err)
					}
					var fields map[string]json.RawMessage
					if err := json.Unmarshal(data, &fields); err != nil {
						t.Error(err)
					}
					if len(fields) != 2 || fields["state"] == nil || fields["note"] == nil {
						t.Error("permission wait changed more than report state and note")
					}
					if err := json.Unmarshal(data, &current); err != nil {
						t.Error(err)
					}
					writes++
					current.Revision = fmt.Sprint(writes)
					if writes == 1 {
						close(waiting)
					} else if writes == 2 {
						close(restored)
					}
					fmt.Fprint(w, `{}`)
				default:
					t.Errorf("unexpected fleet path %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer fleet.Close()
			folder, err := os.MkdirTemp("", "permission-channel-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(folder)
			socket := filepath.Join(folder, "p.sock")
			channel, err := Listen(socket, func(ship, token string) bool {
				return ship == "shp_01m6jyczpnpp5c0vxh54c966cy" && token == "session-for-test"
			}, Fleet{URL: fleet.URL, TokenOf: func(string) string { return "crew-for-test" }})
			if err != nil {
				t.Fatal(err)
			}
			defer channel.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan Decision, 1)
			go func() {
				done <- (Client{Socket: socket, Token: "session-for-test"}).Await(ctx, "shp_01m6jyczpnpp5c0vxh54c966cy", "Run `npm install`")
			}()
			select {
			case <-waiting:
			case <-time.After(5 * time.Second):
				t.Fatal("wait not reported")
			}
			mu.Lock()
			note := current.Note
			mu.Unlock()
			if note != "waiting for its owner: Run `npm install`" {
				t.Fatalf("note = %q", note)
			}
			if end == "trierarch channel closes" {
				if err := channel.Close(); err != nil {
					t.Fatal(err)
				}
			} else {
				cancel()
			}
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("private call not cancelled")
			}
			select {
			case <-restored:
			case <-time.After(5 * time.Second):
				t.Fatal("report not restored")
			}
			mu.Lock()
			defer mu.Unlock()
			if current.State != "working" || current.Note != "building" {
				t.Fatalf("restored = %+v", current)
			}
		})
	}
}

func TestAnAbsentReportReturnsToWorkingWithAnEmptyNote(t *testing.T) {
	fleet := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"report":null,"previousCrew":null}`) }))
	defer fleet.Close()
	got, err := (Fleet{URL: fleet.URL, TokenOf: func(string) string { return "crew-for-test" }}).ReadReport(context.Background(), "scout")
	if err != nil || got.State != "working" || got.Note != "" {
		t.Fatalf("ReadReport = %+v, %v", got, err)
	}
}

type closingQuestion struct{ started, cancelled, cleanup chan struct{} }

func (q closingQuestion) Owner(context.Context, string) (Owner, error) {
	return Owner{IsPerson: true}, nil
}
func (q closingQuestion) Ask(ctx context.Context, _ string, _ Request) Decision {
	close(q.started)
	<-ctx.Done()
	close(q.cancelled)
	<-q.cleanup
	return Decision{Behavior: "deny", Message: "permission call cancelled"}
}
func TestClosingThePrivateChannelWaitsForQuestionWithdrawalBeforeReturning(t *testing.T) {
	folder, err := os.MkdirTemp("", "permission-close-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(folder)
	q := closingQuestion{started: make(chan struct{}), cancelled: make(chan struct{}), cleanup: make(chan struct{})}
	channel, err := Listen(filepath.Join(folder, "p.sock"), func(string, string) bool { return true }, q)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan Decision, 1)
	go func() {
		done <- (Client{Socket: filepath.Join(folder, "p.sock"), Token: "test-session"}).Ask(context.Background(), "scout", Request{Title: "Run `npm install`"})
	}()
	<-q.started
	closed := make(chan struct{})
	go func() { _ = channel.Close(); close(closed) }()
	<-q.cancelled
	select {
	case <-closed:
		close(q.cleanup)
		<-done
		t.Fatal("channel closed before the question's withdrawal finished")
	case <-time.After(20 * time.Millisecond):
	}
	close(q.cleanup)
	<-closed
	<-done
}

func TestDrainingAShipWaitsForWithdrawalOrNamesItAtTheDeadline(t *testing.T) {
	for _, end := range []string{"withdrawn", "deadline"} {
		t.Run(end, func(t *testing.T) {
			folder, err := os.MkdirTemp("", "permission-drain-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(folder)
			q := closingQuestion{started: make(chan struct{}), cancelled: make(chan struct{}), cleanup: make(chan struct{})}
			channel, err := Listen(filepath.Join(folder, "p.sock"), func(string, string) bool { return true }, q)
			if err != nil {
				t.Fatal(err)
			}
			defer channel.Close()
			done := make(chan Decision, 1)
			go func() {
				done <- (Client{Socket: filepath.Join(folder, "p.sock"), Token: "test-session"}).Ask(context.Background(), "scout", Request{Title: "Run `npm install`"})
			}()
			<-q.started
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			drained := make(chan []string, 1)
			go func() { drained <- channel.Drain(ctx, "scout") }()
			<-q.cancelled
			select {
			case <-drained:
				t.Fatal("drain returned before withdrawal or deadline")
			default:
			}
			if end == "withdrawn" {
				close(q.cleanup)
			} else {
				cancel()
			}
			unfinished := <-drained
			if end == "deadline" {
				if len(unfinished) != 1 || unfinished[0] != "permission call" {
					t.Fatalf("unfinished withdrawals: %v", unfinished)
				}
				close(q.cleanup)
			} else if len(unfinished) != 0 {
				t.Fatalf("unfinished withdrawals: %v", unfinished)
			}
			<-done
		})
	}
}

func TestEndingAShipLogsEachWithdrawalStillUnfinishedAfterTenSeconds(t *testing.T) {
	folder, err := os.MkdirTemp("", "permission-end-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(folder)
	q := closingQuestion{started: make(chan struct{}), cancelled: make(chan struct{}), cleanup: make(chan struct{})}
	channel, err := Listen(filepath.Join(folder, "p.sock"), func(string, string) bool { return true }, q)
	if err != nil {
		t.Fatal(err)
	}
	defer channel.Close()
	done := make(chan Decision, 1)
	go func() {
		done <- (Client{Socket: filepath.Join(folder, "p.sock"), Token: "test-session"}).Ask(context.Background(), "scout", Request{UseID: "tool-7", Title: "Run `npm install`"})
	}()
	<-q.started
	var logs []string
	ended := make(chan struct{})
	started := time.Now()
	go func() { channel.End("scout", func(line string) { logs = append(logs, line) }); close(ended) }()
	<-q.cancelled
	select {
	case <-ended:
	case <-time.After(11 * time.Second):
		close(q.cleanup)
		t.Fatal("release did not continue at its 10-second limit")
	}
	elapsed := time.Since(started)
	close(q.cleanup)
	<-done
	if elapsed < 10*time.Second || len(logs) != 1 || logs[0] != "permission withdrawal for scout (tool-7) did not finish within 10 seconds; release continues" {
		t.Fatalf("release took %s, logs %v", elapsed, logs)
	}
}
