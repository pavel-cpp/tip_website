package main

// Wiring (done by the lead in main.go): add a "healthcheck" subcommand that runs
//
//	os.Exit(runHealthcheck())
//
// The distroless image has no shell or curl, so the container healthcheck is
// `/tipd healthcheck`.

import (
	"context"
	"net"
	"net/http"
	"os"
	"time"
)

const healthcheckTimeout = 3 * time.Second

// runHealthcheck probes the local /readyz and returns the process exit code: 0 when it
// answers 200 within three seconds, 1 otherwise.
func runHealthcheck() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	return healthcheckURL("http://" + net.JoinHostPort("127.0.0.1", port) + "/readyz")
}

func healthcheckURL(url string) int {
	ctx, cancel := context.WithTimeout(context.Background(), healthcheckTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil) //nolint:gosec // loopback URL built from the local PORT
	if err != nil {
		return 1
	}
	resp, err := (&http.Client{}).Do(req) //nolint:gosec // same loopback request
	if err != nil {
		return 1
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
