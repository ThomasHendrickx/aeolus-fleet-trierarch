package permissions

import (
	"context"
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
	"time"
)

// The owner answered the second ask first: its answer reaches the store ahead
// of the first ask's. One receive for the first ask must still come back with
// the first ask's answer, not an empty reply that costs a backoff and a call.
func TestOneReceiveForAnAskPassesAnotherAsksAnswerAheadOfIt(t *testing.T) {
	var mu sync.Mutex
	pending := []map[string]any{
		answerDelivery("dlv_01m6jyczpnpp5c0vxh54c966ct", "msg_01m6jyczpnpp5c0vxh54c966cv", "second"),
		answerDelivery("dlv_01m6jyczpnpp5c0vxh54c966cw", "msg_01m6jyczpnpp5c0vxh54c966cx", "first"),
	}
	fleet := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path != "/api/v1/ship/pushReceive" {
			fmt.Fprint(w, `{}`)
			return
		}
		var deliveries []any
		if len(pending) > 0 {
			deliveries = []any{pending[0]}
			pending = pending[1:]
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"deliveries": deliveries})
	}))
	defer fleet.Close()
	_, file, _, _ := runtime.Caller(0)
	p := pluginForAnswerTest(t, file)
	folder := t.TempDir()
	cmd := exec.Command("bash", filepath.Join(p.Root, "scripts/aeolus-identity.sh"), "write", fleet.URL, "shp_01m6jyczpnpp5c0vxh54c966cy", "scout")
	cmd.Env = append(os.Environ(), "AEOLUS_FOLDER="+folder, "AEOLUS_DATA="+p.Data, "AEOLUS_CREWS="+p.Crews, "AEOLUS_HARNESS=claude-code")
	cmd.Stdin = strings.NewReader("test-crew")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("write identity: %v: %s", err, out)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	out, err := p.PermissionReply(ctx, folder, "second")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "dlv_01m6jyczpnpp5c0vxh54c966cw") {
		t.Fatalf("one receive for the first ask answered %q, want the first ask's delivery", out)
	}
}

func answerDelivery(delivery, replyTo, question string) map[string]any {
	payload, _ := json.Marshal(Answer{QuestionID: question, Option: 1})
	return map[string]any{"deliveryId": delivery, "messageId": "msg_01m6jyczpnpp5c0vxh54c966cu", "senderShipId": "shp_01m6jyczpnpp5c0vxh54c966cz", "senderName": "person", "contentType": "application/vnd.aeolus.answer+json", "inReplyTo": replyTo, "payload": string(payload)}
}
