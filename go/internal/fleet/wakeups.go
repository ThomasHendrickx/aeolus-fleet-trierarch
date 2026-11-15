package fleet

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"strings"
	"time"
)

// Watch looks on each wake of the trierarch's own ship, until its lease or ctx ends.
func (c Client) Watch(ctx context.Context, look func(context.Context) error) error {
	delay := time.Duration(1+rand.IntN(5)) * time.Second
	for ctx.Err() == nil {
		opened, err := c.watch(ctx, look)
		var refusal *Refusal
		if errors.As(err, &refusal) && refusal.Code == "LEASE_ENDED" {
			return err
		}
		if opened {
			delay = time.Duration(1+rand.IntN(5)) * time.Second
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		if !opened {
			delay = min(delay*2, time.Minute)
		}
	}
	return ctx.Err()
}

func (c Client) watch(ctx context.Context, look func(context.Context) error) (bool, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(c.URL, "/")+"/api/v1/ship/wakeups", nil)
	if err != nil {
		return false, err
	}
	request.Header.Set("Authorization", "Bearer "+c.CrewToken)
	request.Header.Set("Accept", "text/event-stream")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return false, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		var refusal Refusal
		if err := json.NewDecoder(response.Body).Decode(&refusal); err != nil {
			return false, fmt.Errorf("open wake stream: HTTP %d", response.StatusCode)
		}
		return false, &refusal
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
				return true, err
			}
		case "end":
			return true, &Refusal{Code: "LEASE_ENDED", Message: "the wake stream ended the lease"}
		}
		event = ""
	}
	return true, scanner.Err()
}
