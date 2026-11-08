package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHealthcheckURLStatuses(t *testing.T) {
	for status, want := range map[int]int{200: 0, 503: 1, 404: 1, 500: 1} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) }))
		if got := healthcheckURL(srv.URL + "/readyz"); got != want {
			t.Errorf("status %d: exit = %d, want %d", status, got, want)
		}
		srv.Close()
	}
}

func TestHealthcheckConnectionRefused(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()
	if got := healthcheckURL("http://" + addr + "/readyz"); got != 1 {
		t.Errorf("exit = %d, want 1", got)
	}
}

func TestHealthcheckTimesOut(t *testing.T) {
	if testing.Short() {
		t.Skip("waits for the 3 s timeout")
	}
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)

	start := time.Now()
	if got := healthcheckURL(srv.URL + "/readyz"); got != 1 {
		t.Errorf("exit = %d, want 1", got)
	}
	if d := time.Since(start); d > healthcheckTimeout+2*time.Second {
		t.Errorf("took %v, the probe must give up after about 3 s", d)
	}
}

func TestRunHealthcheckUsesPortAndReadyz(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { gotPath = r.URL.Path }))
	defer srv.Close()
	t.Setenv("PORT", srv.URL[strings.LastIndex(srv.URL, ":")+1:])
	if got := runHealthcheck(); got != 0 {
		t.Errorf("exit = %d, want 0", got)
	}
	if gotPath != "/readyz" {
		t.Errorf("path = %q", gotPath)
	}
}

func TestRunHealthcheckDefaultPortUnreachable(t *testing.T) {
	// Port 1 is never serving in a test environment; the probe must fail fast, not hang.
	t.Setenv("PORT", "1")
	if got := runHealthcheck(); got != 1 {
		t.Errorf("exit = %d, want 1", got)
	}
}
