package keys

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"syscall"
	"time"
)

// Checked is what the vendor said of a key `login` checks (api keys K11): taken, or why not, naming the vendor's status and error type or code, never its message, which may quote part of the key (K7).
type Checked struct {
	IsTaken bool
	Cause   string
}

type vendor struct {
	name    string
	url     string
	headers func(key string) map[string]string
}

var vendors = map[string]vendor{
	"claude-code": {name: "Anthropic", url: "https://api.anthropic.com", headers: func(key string) map[string]string {
		return map[string]string{"x-api-key": key, "anthropic-version": "2023-06-01"}
	}},
	"codex": {name: "OpenAI", url: "https://api.openai.com", headers: func(key string) map[string]string {
		return map[string]string{"authorization": "Bearer " + key}
	}},
}

// keyPattern is what an API key is made of: visible ASCII, no space or line break, so it can travel as a header.
var keyPattern = regexp.MustCompile(`^[\x21-\x7e]+$`)

const checkTimeout = 15 * time.Second

// Check checks the harness's key with one free call to its vendor, the model list, at the vendor's own URL when vendorURL is empty.
func Check(harness string, key string, vendorURL string) Checked {
	at := vendors[harness]
	if vendorURL == "" {
		vendorURL = at.url
	}
	if !keyPattern.MatchString(key) {
		return Checked{Cause: "The key holds a character no API key holds, such as a line break or a space"}
	}
	request, err := http.NewRequest(http.MethodGet, vendorURL+"/v1/models", nil)
	if err != nil {
		return Checked{Cause: fmt.Sprintf("%s could not be reached at %s (no answer)", at.name, vendorURL)}
	}
	for name, value := range at.headers(key) {
		request.Header.Set(name, value)
	}
	client := http.Client{Timeout: checkTimeout}
	answer, err := client.Do(request)
	if err != nil {
		// A failed request's own message quotes what it sent: only its system error is named.
		reason := "no answer"
		var errno syscall.Errno
		if errors.As(err, &errno) {
			reason = errno.Error()
		}
		return Checked{Cause: fmt.Sprintf("%s could not be reached at %s (%s)", at.name, vendorURL, reason)}
	}
	defer answer.Body.Close()
	if answer.StatusCode >= 200 && answer.StatusCode < 300 {
		return Checked{IsTaken: true}
	}
	var refusal struct {
		Error struct {
			Type string  `json:"type"`
			Code *string `json:"code"`
		} `json:"error"`
	}
	cause := fmt.Sprintf("%s refused the key: %d", at.name, answer.StatusCode)
	if json.NewDecoder(answer.Body).Decode(&refusal) == nil {
		if refusal.Error.Code != nil && *refusal.Error.Code != "" {
			cause += " " + *refusal.Error.Code
		} else if refusal.Error.Type != "" {
			cause += " " + refusal.Error.Type
		}
	}
	return Checked{Cause: cause}
}
