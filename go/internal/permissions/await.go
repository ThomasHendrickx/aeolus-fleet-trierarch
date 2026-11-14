package permissions

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
)

// Await keeps the private channel open until the limit or cancellation. Its
// transport has no whole-call timeout; closing the public stream cancels it.
func (c Client) Await(ctx context.Context, ship, title string) Decision {
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", c.Socket)
	}}
	defer transport.CloseIdleConnections()
	text, _ := json.Marshal(map[string]string{"title": title})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://trierarch/"+ship, bytes.NewReader(text))
	failure := Decision{Behavior: "deny", Message: "could not read this ship's owner: nobody is asked"}
	if err != nil {
		return failure
	}
	request.Header.Set("Authorization", "Bearer "+c.Token)
	answer, err := (&http.Client{Transport: transport}).Do(request)
	if err != nil {
		return failure
	}
	defer answer.Body.Close()
	if answer.StatusCode != http.StatusOK {
		return failure
	}
	var decision Decision
	if json.NewDecoder(io.LimitReader(answer.Body, 4096)).Decode(&decision) != nil || decision.Behavior != "deny" {
		return failure
	}
	return decision
}

// Await runs the wait inside the trierarch, where the report's crew token stays.
func (f Fleet) Await(ctx context.Context, ship, title string) Decision {
	clock := f.Clock
	if clock == nil {
		clock = SystemClock{}
	}
	return (Service{Owners: f, Reports: f, Clock: clock, Log: f.Log}).Await(ctx, ship, title)
}

func (f Fleet) call(ctx context.Context, ship, method, path string, body any, output any) error {
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, f.URL+"/api/v1/ship/"+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+f.TokenOf(ship))
	request.Header.Set("Content-Type", "application/json")
	answer, err := (&http.Client{Timeout: ownerTimeout}).Do(request)
	if err != nil {
		return err
	}
	defer answer.Body.Close()
	if answer.StatusCode != http.StatusOK {
		return fmt.Errorf("permission %s status %d", path, answer.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(answer.Body, 64<<10)).Decode(output)
}

// ReadReport reads this crew's current report only.
func (f Fleet) ReadReport(ctx context.Context, ship string) (Report, error) {
	var output struct {
		Report *Report `json:"report"`
	}
	err := f.call(ctx, ship, http.MethodGet, "reportLog", nil, &output)
	if output.Report == nil {
		return Report{State: "working"}, err
	}
	return *output.Report, err
}

// WriteReport changes state and note only, preserving task, step and details.
func (f Fleet) WriteReport(ctx context.Context, ship string, report Report) error {
	return f.call(ctx, ship, http.MethodPost, "report", map[string]string{"state": report.State, "note": report.Note}, &map[string]any{})
}
