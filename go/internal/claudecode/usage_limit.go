package claudecode

import (
	"bufio"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"regexp"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

var usageLimitMessage = regexp.MustCompile(`(?i)you['’]?ve hit your (usage )?limit|usage limit (reached|exceeded)`)

// UsageLimit reads the latest turn's limit stop, preserving the harness's reset wording and event identity (#1629).
func (h Harness) UsageLimit(entry reconciler.Entry) (occurrence string, reason string) {
	file, err := os.Open(h.Events(entry.ShipID))
	if err != nil {
		return "", ""
	}
	defer file.Close()
	lines := bufio.NewScanner(file)
	lines.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for lines.Scan() {
		var event struct {
			Type    string   `json:"type"`
			UUID    string   `json:"uuid"`
			IsError bool     `json:"is_error"`
			Error   string   `json:"error"`
			Result  string   `json:"result"`
			Errors  []string `json:"errors"`
			Message *struct {
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(lines.Bytes(), &event) != nil {
			continue
		}
		if event.Type != "result" && event.Type != "assistant" && event.Type != "user" {
			continue
		}
		isError := event.Type == "result" && event.IsError || event.Type == "assistant" && event.Error == "rate_limit"
		if !isError {
			occurrence, reason = "", ""
			continue
		}
		texts := append([]string{event.Result}, event.Errors...)
		if event.Message != nil {
			for _, block := range event.Message.Content {
				texts = append(texts, block.Text)
			}
		}
		for _, text := range texts {
			if usageLimitMessage.MatchString(text) {
				occurrence, reason = event.UUID, text
				if occurrence == "" {
					occurrence = fmt.Sprintf("%x", sha256.Sum256(lines.Bytes()))
				}
				break
			}
		}
	}
	return occurrence, reason
}
