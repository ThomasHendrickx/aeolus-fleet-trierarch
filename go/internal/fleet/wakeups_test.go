package fleet

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
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
	var opens atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count := opens.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: wake\ndata: {\"reason\":\"open\"}\n\n")
		if count == 2 {
			fmt.Fprint(w, "event: end\ndata: {\"code\":\"LEASE_ENDED\"}\n\n")
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	looks := 0
	err := (Client{URL: server.URL}).Watch(ctx, func(context.Context) error { looks++; return nil })
	var refusal *Refusal
	if opens.Load() != 2 || looks != 2 || !errors.As(err, &refusal) || refusal.Code != "LEASE_ENDED" {
		t.Fatalf("opens = %d, looks = %d, end = %v", opens.Load(), looks, err)
	}
}

func TestWakeStreamReopensAfterSilence(t *testing.T) {
	var opens atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count := opens.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: wake\ndata: {\"reason\":\"open\"}\n\n")
		if count == 2 {
			fmt.Fprint(w, "event: end\ndata: {\"code\":\"LEASE_ENDED\"}\n\n")
			return
		}
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	client := Client{URL: server.URL, wakeTiming: &wakeTiming{silence: 20 * time.Millisecond, safety: time.Hour}}
	err := client.Watch(ctx, func(context.Context) error { return nil })
	var refusal *Refusal
	if opens.Load() != 2 || !errors.As(err, &refusal) || refusal.Code != "LEASE_ENDED" {
		t.Fatalf("opens = %d, end = %v", opens.Load(), err)
	}
}

func TestWakeStreamLooksForLostWakesWithoutReopening(t *testing.T) {
	var opens atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		opens.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: wake\ndata: {\"reason\":\"open\"}\n\n")
		w.(http.Flusher).Flush()
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				fmt.Fprint(w, ": keep-alive\n\n")
				w.(http.Flusher).Flush()
			}
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	looks := 0
	client := Client{URL: server.URL, wakeTiming: &wakeTiming{silence: 50 * time.Millisecond, safety: 20 * time.Millisecond}}
	client.Watch(ctx, func(context.Context) error {
		looks++
		if looks == 5 {
			cancel()
		}
		return nil
	})
	if looks != 5 || opens.Load() != 1 {
		t.Fatalf("looks = %d, opens = %d, want 5 and 1", looks, opens.Load())
	}
}

func TestWakeStreamDoesNotRetryAnEndedLeaseAtOpen(t *testing.T) {
	var opens atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		opens.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"code":"LEASE_ENDED","message":"released"}`)
	}))
	defer server.Close()
	looks := 0
	err := (Client{URL: server.URL}).Watch(context.Background(), func(context.Context) error { looks++; return nil })
	var refusal *Refusal
	if opens.Load() != 1 || looks != 0 || !errors.As(err, &refusal) || refusal.Code != "LEASE_ENDED" {
		t.Fatalf("opens = %d, looks = %d, end = %v", opens.Load(), looks, err)
	}
}

func TestWakeStreamCancellationClosesTheStreamWithoutReopening(t *testing.T) {
	var opens atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		opens.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: wake\ndata: {}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err := (Client{URL: server.URL}).Watch(ctx, func(context.Context) error { cancel(); return nil })
	if opens.Load() != 1 || !errors.Is(err, context.Canceled) {
		t.Fatalf("opens = %d, end = %v", opens.Load(), err)
	}
}

func TestWakeStreamWrapsOpenErrors(t *testing.T) {
	for _, url := range []string{":invalid", "unsupported://fleet"} {
		t.Run(url, func(t *testing.T) {
			_, err := (Client{URL: url}).watch(context.Background(), func(context.Context) error { return nil })
			if err == nil || !strings.HasPrefix(err.Error(), "open wake stream: ") || errors.Unwrap(err) == nil {
				t.Fatalf("watch(%q) = %v, want wrapped open wake stream error", url, err)
			}
		})
	}
}
