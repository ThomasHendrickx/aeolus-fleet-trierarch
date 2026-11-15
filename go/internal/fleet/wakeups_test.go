package fleet

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWakeStreamLooksOnOpenAndWakeAndStopsOnLeaseEnd(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/api/v1/ship/wakeups" || r.Header.Get("Authorization") != "Bearer test-crew" {
			t.Errorf("stream request = %s %s, bearer present = %v", r.Method, r.URL.Path, r.Header.Get("Authorization") != "")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: wake\r\ndata: {\"reason\":\"open\"}\r\n\r\n: keep-alive\n\nevent: wake\ndata: {}\n\nevent: end\ndata: {\"code\":\"LEASE_ENDED\"}\n\n")
	}))
	defer server.Close()
	looks := 0
	err := (Client{URL: server.URL, CrewToken: "test-crew"}).Watch(context.Background(), func(context.Context) error { looks++; return nil })
	var refusal *Refusal
	if looks != 2 || !errors.As(err, &refusal) || refusal.Code != "LEASE_ENDED" {
		t.Fatalf("looks = %d, end = %v, want 2 and LEASE_ENDED", looks, err)
	}
}

func TestWakeStreamReopensAfterADropAndLooksAgain(t *testing.T) {
	opens := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		opens++
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: wake\ndata: {\"reason\":\"open\"}\n\n")
		if opens == 2 {
			fmt.Fprint(w, "event: end\ndata: {\"code\":\"LEASE_ENDED\"}\n\n")
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	looks := 0
	err := (Client{URL: server.URL}).Watch(ctx, func(context.Context) error { looks++; return nil })
	var refusal *Refusal
	if opens != 2 || looks != 2 || !errors.As(err, &refusal) || refusal.Code != "LEASE_ENDED" {
		t.Fatalf("opens = %d, looks = %d, end = %v", opens, looks, err)
	}
}
