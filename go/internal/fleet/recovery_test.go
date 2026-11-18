package fleet

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestTheNextCallReachesTheFleetAfterAHungHTTP2Connection(t *testing.T) {
	// A network interruption leaves the TCP connection open, but no request
	// on that connection gets headers. A newly dialled connection works.
	type connectionKey struct{}
	var connections atomic.Int32
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor != 2 {
			t.Errorf("protocol = %s, want HTTP/2", r.Proto)
		}
		if r.Context().Value(connectionKey{}).(int32) == 1 {
			<-r.Context().Done()
			return
		}
		_, _ = w.Write([]byte(`{"shipId":"recovered"}`))
	}))
	server.EnableHTTP2 = true
	server.Config.ConnContext = func(ctx context.Context, _ net.Conn) context.Context {
		return context.WithValue(ctx, connectionKey{}, connections.Add(1))
	}
	server.StartTLS()
	defer server.Close()
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.ForceAttemptHTTP2 = true
	previous := http.DefaultTransport
	http.DefaultTransport = transport
	defer func() { http.DefaultTransport = previous; transport.CloseIdleConnections() }()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	var answer struct {
		ShipID string `json:"shipId"`
	}
	err := callIn(ctx, server.URL, request{path: "/ship/whoami"}, &answer)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("hung call = %v, want deadline exceeded", err)
	}

	next, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	if err := callIn(next, server.URL, request{path: "/ship/whoami"}, &answer); err != nil {
		t.Fatalf("next call = %v, want recovery on a fresh connection", err)
	}
	if answer.ShipID != "recovered" {
		t.Fatalf("next answer = %q, want recovered", answer.ShipID)
	}
}
