package main

import (
	"os"
	"testing"

	"github.com/testcontainers/testcontainers-go"

	"github.com/pavel-cpp/tip_website/backend/internal/platform/dbtest"
)

// TestMain removes the shared Postgres and Redis containers after the tests, so they do not
// outlive the binary when the testcontainers reaper is disabled.
func TestMain(m *testing.M) {
	code := m.Run()
	dbtest.Terminate()
	if redisContainer != nil {
		_ = testcontainers.TerminateContainer(redisContainer)
	}
	os.Exit(code)
}
