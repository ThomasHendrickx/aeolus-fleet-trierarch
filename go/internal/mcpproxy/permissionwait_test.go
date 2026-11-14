package mcpproxy

import (
 "context"
 "net/http"
 "net/http/httptest"
 "os"
 "strings"
 "testing"
 "testing/synctest"
 "time"

 "github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/permissions"
)

func TestPermissionWaitStreamsProgressPastASilentCallsLimitAndDeniesAtThirtyMinutes(t *testing.T) {
 synctest.Test(t, func(t *testing.T) {
  sessions := t.TempDir()
  aSession(t, sessions, scout, os.Getpid(), Access{Token:"permission-token", Servers:[]string{permissions.Server}})
  calls := NewPermissionCalls()
  proxy := Proxy{Sessions:sessions, PermissionCalls:calls, PermissionWait:func(ctx context.Context, ship, token, title string) permissions.Decision {
   if title != "Run `npm install`" { t.Errorf("title = %q", title) }
   return permissions.Wait(ctx, permissions.SystemClock{})
  }}
  request := httptest.NewRequest(http.MethodPost, PathOf(scout, permissions.Server), strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ask","arguments":{"tool_name":"Bash","input":{"command":"npm install"}},"_meta":{"progressToken":"permission-7"}}}`))
  request.Header.Set("Authorization", "Bearer permission-token")
  answer := httptest.NewRecorder()
  done := make(chan struct{})
  go func(){ defer close(done); proxy.ServeHTTP(answer,request) }()
  synctest.Wait()
  for range 89 {time.Sleep(20*time.Second);synctest.Wait()}
  select {case <-done:t.Fatal("wait ended before 30 minutes");default:}
  time.Sleep(20*time.Second); <-done
  if answer.Header().Get("Content-Type")!="text/event-stream" {t.Fatal(answer.Header())}
  body:=answer.Body.String()
  progress:=strings.Count(body,`"method":"notifications/progress"`)
  if progress<89 || progress>90 || strings.Count(body,`"progressToken":"permission-7"`)!=progress || !strings.Contains(body,"not answered in 30 minutes; the question was withdrawn") {t.Fatalf("progress %d, body %s",progress,body)}
  if calls.Count()!=0 {t.Fatal("wait remains registered")}
 })
}

func TestPermissionWaitEndsOnCancelOrConnectionCloseAndLeavesNoWait(t *testing.T) {
 for _, end:=range []string{"cancel", "restart", "release", "retire", "give back", "session dying"} {
 t.Run(end,func(t *testing.T){synctest.Test(t,func(t *testing.T){
  sessions:=t.TempDir()
  aSession(t,sessions,scout,os.Getpid(),Access{Token:"permission-token",Servers:[]string{permissions.Server}})
  calls:=NewPermissionCalls()
  ended:=make(chan struct{})
  proxy:=Proxy{Sessions:sessions,PermissionCalls:calls,PermissionWait:func(ctx context.Context,_,_,_ string) permissions.Decision {defer close(ended);return permissions.Wait(ctx,permissions.SystemClock{})}}
  ctx,closeConnection:=context.WithCancel(context.Background());defer closeConnection()
  request:=httptest.NewRequest(http.MethodPost,PathOf(scout,permissions.Server),strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ask"}}`)).WithContext(ctx)
  request.Header.Set("Authorization","Bearer permission-token")
  answer:=httptest.NewRecorder();done:=make(chan struct{})
  go func(){defer close(done);proxy.ServeHTTP(answer,request)}()
  synctest.Wait()
  if end=="cancel" {
   cancel:=httptest.NewRequest(http.MethodPost,PathOf(scout,permissions.Server),strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}`))
   cancel.Header.Set("Authorization","Bearer permission-token")
   proxy.ServeHTTP(httptest.NewRecorder(),cancel)
  } else {closeConnection()}
  <-ended; <-done
  if calls.Count()!=0 {t.Fatal("permission call remains registered")}
  if strings.Contains(answer.Body.String(),`"result"`) {t.Fatalf("cancel returned a tool result: %s",answer.Body.String())}
 })})
 }
}
