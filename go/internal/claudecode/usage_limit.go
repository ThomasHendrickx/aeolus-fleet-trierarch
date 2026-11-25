package claudecode

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"regexp"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/eventlog"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/reconciler"
)

var usageLimitMessage = regexp.MustCompile(`(?i)you['’]?ve hit your (usage )?limit|usage limit (reached|exceeded)`)

// UsageLimit reads the latest turn's limit stop, preserving the harness's reset wording and event identity (#1629).
func (h Harness) UsageLimit(entry reconciler.Entry) (occurrence string, reason string) {
	files, err := eventlog.OpenDisk(h.Events(entry.ShipID))
	if err != nil {
		return "", ""
	}
	defer files.Close()
	isPendingLimit := false
	reset := ""
	for line, err := range files.Lines() {
		if err != nil {
			break
		}
		var event struct {
			Type          string `json:"type"`
			RateLimitInfo *struct {
				Status   string `json:"status"`
				ResetsAt int64  `json:"resetsAt"`
			} `json:"rate_limit_info"`
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
		if json.Unmarshal(line, &event) != nil {
			continue
		}
		if event.Type == "rate_limit_event" {
			if event.RateLimitInfo != nil && event.RateLimitInfo.Status == "rejected" {
				reset = ""
				if at := event.RateLimitInfo.ResetsAt; at > 0 && at <= 253402300799 {
					reset = "; resets at " + time.Unix(at, 0).UTC().Format("2006-01-02T15:04:05.000Z")
				}
				if occurrence == "" || !isPendingLimit {
					occurrence = event.UUID
					if occurrence == "" {
						occurrence = fmt.Sprintf("%x", sha256.Sum256(line))
					}
				}
				reason = "Usage limit reached" + reset
				isPendingLimit = true
			}
			continue
		}
		if event.Type != "result" && event.Type != "assistant" && event.Type != "user" {
			continue
		}
		isError := event.Type == "result" && event.IsError || event.Type == "assistant" && event.Error == "rate_limit"
		texts := append([]string{event.Result}, event.Errors...)
		if event.Message != nil {
			for _, block := range event.Message.Content {
				texts = append(texts, block.Text)
			}
		}
		matched := ""
		if isError {
			for _, text := range texts {
				if usageLimitMessage.MatchString(text) {
					matched = text
					break
				}
			}
		}
		if isError && isPendingLimit && occurrence != "" {
			if matched != "" {
				reason = matched + reset
			}
		} else {
			occurrence, reason = "", ""
			if matched != "" {
				occurrence, reason = event.UUID, matched
				if occurrence == "" {
					occurrence = fmt.Sprintf("%x", sha256.Sum256(line))
				}
			}
		}
		isPendingLimit = event.Type == "assistant" && occurrence != ""
		if !isPendingLimit {
			reset = ""
		}
	}
	return occurrence, reason
}
