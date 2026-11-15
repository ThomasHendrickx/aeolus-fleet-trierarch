package fleet

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
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
