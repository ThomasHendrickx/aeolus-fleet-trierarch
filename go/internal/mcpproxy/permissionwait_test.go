package mcpproxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/permissions"
)

func TestPermissionWaitStreamsProgressPastASilentCallsLimitAndDeniesAtThirtyMinutes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		sessions := t.TempDir()
		aSession(t, sessions, scout, os.Getpid(), Access{Token: "permission-token", Servers: []string{permissions.Server}})
		calls := NewPermissionCalls()
		proxy := Proxy{Sessions: sessions, PermissionCalls: calls, PermissionWait: func(ctx context.Context, ship, token string, request permissions.Request) permissions.Decision {
			if request.Title != "Run `npm install`" {
				t.Errorf("title = %q", request.Title)
			}
			return permissions.Wait(ctx, permissions.SystemClock{})
		}}
		request := httptest.NewRequest(http.MethodPost, PathOf(scout, permissions.Server), strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ask","arguments":{"tool_name":"Bash","input":{"command":"npm install"}},"_meta":{"progressToken":"permission-7"}}}`))
		request.Header.Set("Authorization", "Bearer permission-token")
		answer := &waitRecorder{ResponseRecorder: httptest.NewRecorder()}
		done := make(chan struct{})
		go func() { defer close(done); proxy.ServeHTTP(answer, request) }()
		synctest.Wait()
		for tick := 1; tick <= 89; tick++ {
			time.Sleep(19 * time.Second)
			synctest.Wait()
			if got := strings.Count(answer.body(), `"method":"notifications/progress"`); got != tick-1 {
				t.Fatalf("early progress %d at tick %d", got, tick)
			}
			time.Sleep(time.Second)
			synctest.Wait()
			if got := strings.Count(answer.body(), `"method":"notifications/progress"`); got != tick {
				t.Fatalf("progress %d at tick %d", got, tick)
			}
		}
		select {
		case <-done:
			t.Fatal("wait ended before 30 minutes")
		default:
		}
		time.Sleep(20 * time.Second)
		<-done
		if answer.Header().Get("Content-Type") != "text/event-stream" {
			t.Fatal(answer.Header())
		}
		body := answer.body()
		progress := strings.Count(body, `"method":"notifications/progress"`)
		if progress < 89 || progress > 90 || strings.Count(body, `"progressToken":"permission-7"`) != progress || !strings.Contains(body, "not answered in 30 minutes; the question was withdrawn") {
			t.Fatalf("progress %d, body %s", progress, body)
		}
		if calls.count() != 0 {
			t.Fatal("wait remains registered")
		}
	})
}

func TestPermissionWaitEndsOnCancelOrConnectionCloseAndLeavesNoWait(t *testing.T) {
	for _, end := range []string{"cancel", "restart", "release", "retire", "give back", "session dying"} {
		t.Run(end, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				sessions := t.TempDir()
				aSession(t, sessions, scout, os.Getpid(), Access{Token: "permission-token", Servers: []string{permissions.Server}})
				calls := NewPermissionCalls()
				ended := make(chan struct{})
				proxy := Proxy{Sessions: sessions, PermissionCalls: calls, PermissionWait: func(ctx context.Context, _, _ string, _ permissions.Request) permissions.Decision {
					defer close(ended)
					return permissions.Wait(ctx, permissions.SystemClock{})
				}}
				ctx, closeConnection := context.WithCancel(context.Background())
				defer closeConnection()
				request := httptest.NewRequest(http.MethodPost, PathOf(scout, permissions.Server), strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ask"}}`)).WithContext(ctx)
				request.Header.Set("Authorization", "Bearer permission-token")
				answer := &waitRecorder{ResponseRecorder: httptest.NewRecorder()}
				done := make(chan struct{})
				go func() { defer close(done); proxy.ServeHTTP(answer, request) }()
				synctest.Wait()
				if end == "cancel" {
					cancel := httptest.NewRequest(http.MethodPost, PathOf(scout, permissions.Server), strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}`))
					cancel.Header.Set("Authorization", "Bearer permission-token")
					proxy.ServeHTTP(httptest.NewRecorder(), cancel)
				} else {
					closeConnection()
				}
				<-ended
				<-done
				if calls.count() != 0 {
					t.Fatal("permission call remains registered")
				}
				if strings.Contains(answer.body(), `"result"`) {
					t.Fatalf("cancel returned a tool result: %s", answer.body())
				}
			})
		})
	}
}

// The virtual clock can advance as soon as the test sleeps; the recorder also
// synchronizes an observation with the next progress write for the race check.
type waitRecorder struct {
	mu sync.Mutex
	*httptest.ResponseRecorder
}

func (w *waitRecorder) Write(text []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.ResponseRecorder.Write(text)
}
func (w *waitRecorder) body() string { w.mu.Lock(); defer w.mu.Unlock(); return w.Body.String() }

func TestPermissionCallCarriesTheWholeToolInputToThePrivateChannel(t *testing.T) {
	sessions := t.TempDir()
	aSession(t, sessions, scout, os.Getpid(), Access{Token: "permission-token", Servers: []string{permissions.Server}})
	var got permissions.Request
	proxy := Proxy{Sessions: sessions, PermissionCalls: NewPermissionCalls(), PermissionWait: func(_ context.Context, _, _ string, request permissions.Request) permissions.Decision {
		got = request
		return permissions.Decision{Behavior: "deny", Message: "could not ask"}
	}}
	request := httptest.NewRequest(http.MethodPost, PathOf(scout, permissions.Server), strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ask","arguments":{"tool_name":"Edit","input":{"file_path":"src/a.ts","old_string":"before","new_string":"after"}}}}`))
	request.Header.Set("Authorization", "Bearer permission-token")
	proxy.ServeHTTP(httptest.NewRecorder(), request)
	if got.Tool != "Edit" || got.Title != "Edit `src/a.ts`" || string(got.Input) != `{"file_path":"src/a.ts","old_string":"before","new_string":"after"}` {
		text, _ := json.Marshal(got)
		t.Fatalf("request = %s", text)
	}
}
