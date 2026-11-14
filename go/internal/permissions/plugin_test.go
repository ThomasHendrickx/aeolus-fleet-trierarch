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

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/plugin"
)

func TestPluginQuestionsNameTheActionRuleInputShipAndModel(t *testing.T) {
	for _, test := range []struct{ name, tool, input, title, rule string }{
		{"Bash", "Bash", `{"command":"npm install"}`, "Run `npm install`", "npm install"},
		{"Edit", "Edit", `{"file_path":"src/a.ts","old_string":"before","new_string":"after"}`, "Edit `src/a.ts`", "src/a.ts"},
		{"Read", "Read", `{"file_path":"src/a.ts"}`, "Read `src/a.ts`", "src/a.ts"},
		{"NotebookEdit", "NotebookEdit", `{"notebook_path":"notes.ipynb"}`, "NotebookEdit `notes.ipynb`", "notes.ipynb"},
		{"4 KB input", "Bash", `{"command":"echo","description":"` + strings.Repeat("x", 4061) + `"}`, "Run `echo`", "echo"},
		{"one over 4 KB", "Bash", `{"command":"echo","description":"` + strings.Repeat("x", 4062) + `"}`, "Run `echo`", "echo"},
		{"other tool", "Search", `{"query":"ships"}`, "Search", "Search"},
		{"5 KB input", "Bash", `{"command":"echo","description":"` + strings.Repeat("x", 5*1024) + `"}`, "Run `echo`", "echo"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var mu sync.Mutex
			var sends []struct{ ContentType, Payload, Model string }
			fleet := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/ship/whoami" {
					fmt.Fprint(w, `{"ownerShipId":"shp_01m6jyczpnpp5c0vxh54c966cz","ownerName":"thomas"}`)
					return
				}
				if r.URL.Path != "/api/v1/ship/send" {
					t.Errorf("unexpected path %s", r.URL.Path)
					w.WriteHeader(404)
					return
				}
				var sent struct{ ContentType, Payload, Model string }
				if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
					t.Error(err)
				}
				mu.Lock()
				sends = append(sends, sent)
				mu.Unlock()
				fmt.Fprint(w, `{"messageId":"msg_01m6jyczpnpp5c0vxh54c966cx"}`)
			}))
			defer fleet.Close()
			_, file, _, _ := runtime.Caller(0)
			p := plugin.Plugin{Root: filepath.Join(filepath.Dir(file), "../../../plugins/aeolus-fleet"), Data: t.TempDir(), Crews: t.TempDir()}
			folder := t.TempDir()
			cmd := exec.Command("bash", filepath.Join(p.Root, "scripts/aeolus-identity.sh"), "write", fleet.URL, "shp_01m6jyczpnpp5c0vxh54c966cy", "scout")
			cmd.Env = append(os.Environ(), "AEOLUS_FOLDER="+folder, "AEOLUS_DATA="+p.Data, "AEOLUS_CREWS="+p.Crews, "AEOLUS_HARNESS=claude-code")
			cmd.Stdin = strings.NewReader("test-crew")
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("write identity: %v: %s", err, out)
			}
			isCrewed := true
			questions := PluginQuestions{Session: func(string) (QuestionSession, error) {
				if !isCrewed {
					return QuestionSession{}, fmt.Errorf("session released")
				}
				return QuestionSession{Plugin: p, Folder: folder, Name: "scout", Model: "claude-opus-5-5"}, nil
			}}
			id, err := questions.Ask(context.Background(), "shp_01m6jyczpnpp5c0vxh54c966cy", Request{Tool: test.tool, Input: json.RawMessage(test.input)})
			if err != nil {
				t.Fatal(err)
			}
			isCrewed = false
			if err := questions.Withdraw(context.Background(), "shp_01m6jyczpnpp5c0vxh54c966cy", id); err != nil {
				t.Fatal(err)
			}
			mu.Lock()
			defer mu.Unlock()
			if len(sends) != 2 || sends[0].ContentType != "application/vnd.aeolus.question+json" || sends[1].ContentType != "application/vnd.aeolus.question-withdrawal+json" {
				t.Fatalf("sends = %+v", sends)
			}
			var question struct {
				ID, Title, Context string
				Options            []struct {
					Key           int
					Label, Detail string
				}
				Pick struct {
					Option int
					Why    string
				}
			}
			if err := json.Unmarshal([]byte(sends[0].Payload), &question); err != nil {
				t.Fatal(err)
			}
			if question.ID != id || question.Title != test.title || sends[0].Model != "claude-opus-5-5" || sends[1].Model != "claude-opus-5-5" {
				t.Fatalf("question %+v, models %q %q", question, sends[0].Model, sends[1].Model)
			}
			if len(question.Options) != 3 || question.Options[0].Label != "Allow once" || question.Options[1].Label != "Allow for this session" || !strings.Contains(question.Options[1].Detail, test.rule) || question.Options[2].Label != "Deny" || question.Pick.Option != 3 || question.Pick.Why != "nothing runs without your yes" {
				t.Fatalf("options/pick = %+v", question)
			}
			if !strings.Contains(question.Context, "scout") {
				t.Fatalf("context = %q", question.Context)
			}
			if test.name == "5 KB input" {
				if !strings.Contains(question.Context, "1059 bytes cut") || strings.Contains(question.Context, strings.Repeat("x", 4096)) {
					t.Fatalf("context not cut at 4096 bytes: %q", question.Context)
				}
			} else if test.name == "one over 4 KB" {
				if !strings.Contains(question.Context, "[1 bytes cut]") {
					t.Fatalf("context: %q", question.Context)
				}
			} else if !strings.Contains(question.Context, test.input) {
				t.Fatalf("missing whole input: %q", question.Context)
			}
		})
	}
}
