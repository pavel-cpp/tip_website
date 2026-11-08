package db

import (
	"os"
	"testing"

	"github.com/pavel-cpp/tip_website/backend/internal/platform/dbtest"
)

// TestMain removes the shared Postgres container after the tests, so it does not outlive the
// binary when the testcontainers reaper is disabled.
func TestMain(m *testing.M) {
	code := m.Run()
	dbtest.Terminate()
	os.Exit(code)
}
