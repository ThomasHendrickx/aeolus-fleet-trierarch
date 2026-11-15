package fleet

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

type wakeTiming struct {
	silence time.Duration
	safety  time.Duration
}

type wakeReader struct {
	io.Reader
	timer   *time.Timer
	silence time.Duration
}

func (r wakeReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if n > 0 {
		r.timer.Reset(r.silence)
	}
	return n, err
}

func (c Client) watch(parent context.Context, look func(context.Context) error) (bool, error) {
	timing := wakeTiming{silence: time.Minute, safety: 5 * time.Minute}
	if c.wakeTiming != nil {
		timing = *c.wakeTiming
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	silence := time.AfterFunc(timing.silence, cancel)
	defer silence.Stop()
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
	lines := make(chan string)
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		defer close(lines)
		scanner := bufio.NewScanner(wakeReader{Reader: response.Body, timer: silence, silence: timing.silence})
		for scanner.Scan() {
			select {
			case lines <- scanner.Text():
			case <-ctx.Done():
				return
			}
		}
	}()
	defer func() { cancel(); response.Body.Close(); <-readDone }()
	event := ""
	for {
		select {
		case <-ctx.Done():
			return true, ctx.Err()
		case line, ok := <-lines:
			if !ok {
				return true, io.EOF
			}
			if strings.HasPrefix(line, "event:") {
				event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			}
			if line != "" {
				continue
			}
			switch event {
			case "wake":
				if err := look(parent); err != nil {
					return true, err
				}
			case "end":
				return true, &Refusal{Code: "LEASE_ENDED", Message: "the wake stream ended the lease"}
			}
			event = ""
		}
	}
}
