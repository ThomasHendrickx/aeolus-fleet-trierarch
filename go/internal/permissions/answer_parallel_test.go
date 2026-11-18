package permissions

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestTwoOpenPermissionAsksTakeTheirOwnAnswersWhenTheOwnerAnswersOutOfOrder(t *testing.T) {
	var mu sync.Mutex
	var ids []string
	var pending []any
	var taken int
	fleet := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/api/v1/ship/whoami":
			fmt.Fprint(w, `{"ownerShipId":"shp_01m6jyczpnpp5c0vxh54c966cz","ownerName":"person"}`)
		case "/api/v1/ship/send":
			var message struct{ Payload string }
			_ = json.NewDecoder(r.Body).Decode(&message)
			var q struct{ ID string }
			_ = json.Unmarshal([]byte(message.Payload), &q)
			ids = append(ids, q.ID)
			msg := "msg_01m6jyczpnpp5c0vxh54c966cx"
			if len(ids) == 2 {
				msg = "msg_01m6jyczpnpp5c0vxh54c966cv"
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"messageId": msg})
			if len(ids) == 2 {
				for _, i := range []int{1, 0} {
					payload, _ := json.Marshal(Answer{QuestionID: ids[i], Option: 1})
					delivery := "dlv_01m6jyczpnpp5c0vxh54c966cw"
					replyTo := "msg_01m6jyczpnpp5c0vxh54c966cx"
					if i == 1 {
						delivery = "dlv_01m6jyczpnpp5c0vxh54c966ct"
						replyTo = "msg_01m6jyczpnpp5c0vxh54c966cv"
					}
					pending = append(pending, map[string]any{"deliveryId": delivery, "messageId": "msg_01m6jyczpnpp5c0vxh54c966cu", "senderShipId": "shp_01m6jyczpnpp5c0vxh54c966cz", "senderName": "person", "contentType": "application/vnd.aeolus.answer+json", "inReplyTo": replyTo, "payload": string(payload)})
				}
			}
		case "/api/v1/ship/pushReceive":
			var deliveries []any
			if len(pending) > 0 {
				deliveries = pending[:1]
				pending = pending[1:]
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"deliveries": deliveries})
		case "/api/v1/ship/ack":
			fmt.Fprint(w, `{}`)
		case "/api/v1/ship/handled":
			taken++
			fmt.Fprint(w, `{}`)
		default:
			t.Errorf("unexpected %s", r.URL.Path)
			http.Error(w, "unexpected", 404)
		}
	}))
	defer fleet.Close()
	_, file, _, _ := runtime.Caller(0)
	p := pluginForAnswerTest(t, file)
	folder := t.TempDir()
	ship := "shp_01m6jyczpnpp5c0vxh54c966cy"
	cmd := exec.Command("bash", filepath.Join(p.Root, "scripts/aeolus-identity.sh"), "write", fleet.URL, ship, "scout")
	cmd.Env = append(os.Environ(), "AEOLUS_FOLDER="+folder, "AEOLUS_DATA="+p.Data, "AEOLUS_CREWS="+p.Crews, "AEOLUS_HARNESS=claude-code")
	cmd.Stdin = strings.NewReader("test-crew")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("write identity: %v: %s", err, out)
	}
	q := &PluginQuestions{Session: func(string) (QuestionSession, error) {
		return QuestionSession{Plugin: p, Folder: folder, Name: "scout", Model: "claude-opus-5-5"}, nil
	}}
	ctx := t.Context()
	first, err := q.Ask(ctx, ship, Request{Tool: "Bash"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := q.Ask(ctx, ship, Request{Tool: "Write"})
	if err != nil {
		t.Fatal(err)
	}
	// Reading the first ask must leave the second ask's earlier answer alone.
	reply, err := q.Receive(ctx, ship, first)
	if err != nil || !reply.Matches || reply.QuestionID != first {
		t.Fatalf("first ask received %+v, %v", reply, err)
	}
	if err := q.Finish(ctx, ship, reply, true); err != nil {
		t.Fatal(err)
	}
	reply, err = q.Receive(ctx, ship, second)
	if err != nil || !reply.Matches || reply.QuestionID != second {
		t.Fatalf("second ask received %+v, %v", reply, err)
	}
	if err := q.Finish(ctx, ship, reply, true); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if taken != 2 {
		t.Fatalf("taken = %d, want 2", taken)
	}
}
