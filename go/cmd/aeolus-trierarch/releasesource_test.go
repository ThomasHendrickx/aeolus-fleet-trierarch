package main

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// On a network that stalls HTTP/2, the release download recovers through the fallback as production configures it: the clients releases builds, over a TLS server that negotiates HTTP/2 and stalls it.
func TestTheProductionReleaseClientsRecoverAStalledHTTP2TransferOverHTTP11(t *testing.T) {
	var seen sync.Mutex
	var protocols []string
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Lock()
		protocols = append(protocols, r.Proto)
		seen.Unlock()
		if r.ProtoMajor == 2 {
			<-r.Context().Done()
			return
		}
		_, _ = w.Write([]byte(`{"tag_name":"v0.40.0"}`))
	}))
	server.EnableHTTP2 = true
	server.StartTLS()
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())

	source := releases(nil).source
	source.API = server.URL
	// Only the trust in the test server and the wait are the test's; the transports stay production's.
	primary := http.DefaultTransport.(*http.Transport).Clone()
	primary.TLSClientConfig.RootCAs = roots
	source.Client = &http.Client{Transport: primary, Timeout: 300 * time.Millisecond}
	fallback := source.Fallback.Transport.(*http.Transport)
	if fallback.TLSClientConfig == nil {
		fallback.TLSClientConfig = &tls.Config{}
	}
	fallback.TLSClientConfig.RootCAs = roots
	source.Fallback = &http.Client{Transport: fallback, Timeout: 5 * time.Second}

	version, err := source.Latest(t.Context())

	if err != nil || version != "0.40.0" {
		t.Fatalf("Latest after a stalled HTTP/2 transfer = %q, %v, want 0.40.0", version, err)
	}
	seen.Lock()
	defer seen.Unlock()
	if len(protocols) != 2 || protocols[0] != "HTTP/2.0" || protocols[1] != "HTTP/1.1" {
		t.Fatalf("the server saw %v, want a stalled HTTP/2.0 try and then an HTTP/1.1 retry", protocols)
	}
}
