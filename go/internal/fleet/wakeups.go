package fleet

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// Watch looks on each wake of the trierarch's own ship, until its lease or ctx ends.
func (c Client) Watch(ctx context.Context, look func(context.Context) error) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(c.URL, "/")+"/api/v1/ship/wakeups", nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.CrewToken)
	request.Header.Set("Accept", "text/event-stream")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		var refusal Refusal
		if err := json.NewDecoder(response.Body).Decode(&refusal); err != nil {
			return fmt.Errorf("open wake stream: HTTP %d", response.StatusCode)
		}
		return &refusal
	}
	scanner := bufio.NewScanner(response.Body)
	event := ""
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event:") {
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		}
		if line != "" {
			continue
		}
		switch event {
		case "wake":
			if err := look(ctx); err != nil {
				return err
			}
		case "end":
			return &Refusal{Code: "LEASE_ENDED", Message: "the wake stream ended the lease"}
		}
		event = ""
	}
	return scanner.Err()
}
