package permissions

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
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

func TestAnOwnersAnswerTravelsFromThePluginStoreThroughThePrivateChannel(t *testing.T) {
	for _, option := range []int{1, 2, 3, 0} {
		t.Run(fmt.Sprint(option), func(t *testing.T) {
			var mu sync.Mutex
			var pending []any
			var taken, withdrawals int
			report := Report{State: "working", Note: "before", Revision: "before"}
			fleet := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				switch r.URL.Path {
				case "/api/v1/ship/whoami":
					fmt.Fprint(w, `{"ownerShipId":"shp_01m6jyczpnpp5c0vxh54c966cz","ownerName":"person"}`)
				case "/api/v1/ship/ask":
					var q struct{ ID string }
					if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
						t.Error(err)
					}
					payload, _ := json.Marshal(Answer{QuestionID: q.ID, Option: option, Note: "owner note"})
					pending = append(pending, map[string]any{"deliveryId": "dlv_01m6jyczpnpp5c0vxh54c966cw", "messageId": "msg_01m6jyczpnpp5c0vxh54c966cu", "senderShipId": "shp_01m6jyczpnpp5c0vxh54c966cz", "senderName": "person", "contentType": "application/vnd.aeolus.answer+json", "inReplyTo": "msg_01m6jyczpnpp5c0vxh54c966cx", "payload": string(payload)})
					fmt.Fprint(w, `{"messageId":"msg_01m6jyczpnpp5c0vxh54c966cx"}`)
				case "/api/v1/ship/send":
					withdrawals++
					fmt.Fprint(w, `{"messageId":"msg_01m6jyczpnpp5c0vxh54c966cx"}`)
				case "/api/v1/ship/pushReceive":
					_ = json.NewEncoder(w).Encode(map[string]any{"deliveries": pending})
					pending = nil
				case "/api/v1/ship/ack":
					fmt.Fprint(w, `{}`)
				case "/api/v1/ship/handled":
					taken++
					fmt.Fprint(w, `{}`)
				case "/api/v1/ship/reportLog":
					_ = json.NewEncoder(w).Encode(map[string]any{"report": report})
				case "/api/v1/ship/report":
					_ = json.NewDecoder(r.Body).Decode(&report)
					report.Revision += "x"
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
			cmd := exec.Command("bash", filepath.Join(p.Root, "scripts/aeolus-identity.sh"), "write", fleet.URL, "shp_01m6jyczpnpp5c0vxh54c966cy", "scout")
			cmd.Env = append(os.Environ(), "AEOLUS_FOLDER="+folder, "AEOLUS_DATA="+p.Data, "AEOLUS_CREWS="+p.Crews, "AEOLUS_HARNESS=claude-code")
			cmd.Stdin = strings.NewReader("test-crew")
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("write identity: %v: %s", err, out)
			}
			questions := &PluginQuestions{Session: func(string) (QuestionSession, error) {
				return QuestionSession{Plugin: p, Folder: folder, Name: "scout", Model: "claude-opus-5-5"}, nil
			}}
			short, err := os.MkdirTemp("", "answer-channel-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(short)
			socket := filepath.Join(short, "p.sock")
			channel, err := Listen(socket, func(string, string) bool { return true }, Fleet{URL: fleet.URL, TokenOf: func(string) string { return "test-crew" }, Questions: questions})
			if err != nil {
				t.Fatal(err)
			}
			defer channel.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10e9)
			defer cancel()
			input := json.RawMessage(`{"command":"npm ci","description":"` + strings.Repeat("x", 5000) + `"}`)
			got := (Client{Socket: socket, Token: "test-session"}).Ask(ctx, "shp_01m6jyczpnpp5c0vxh54c966cy", Request{Tool: "Bash", Input: input})
			if option == 1 || option == 2 {
				if got.Behavior != "allow" || string(got.UpdatedInput) != string(input) {
					t.Fatalf("allow result = %+v", got)
				}
				if (option == 2) != (len(got.UpdatedPermissions) == 1) {
					t.Fatalf("rules = %+v", got.UpdatedPermissions)
				}
			} else if got.Behavior != "deny" || got.Message != "owner note" {
				t.Fatalf("deny result = %+v", got)
			}
			mu.Lock()
			if taken != 1 || withdrawals != 0 || report.Note != "before" {
				t.Fatalf("taken %d withdrawals %d report %+v", taken, withdrawals, report)
			}
			mu.Unlock()
			if _, ok := p.HandOverLine(folder); ok {
				t.Fatal("accepted permission answer was handed as a prompt")
			}
		})
	}
}

func pluginForAnswerTest(t *testing.T, file string) plugin.Plugin {
	t.Helper()
	return plugin.Plugin{Root: filepath.Join(filepath.Dir(file), "../../../plugins/aeolus-fleet"), Data: t.TempDir(), Crews: t.TempDir()}
}
