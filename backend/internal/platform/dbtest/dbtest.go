// Package dbtest hands integration tests a PostgreSQL DSN. It is imported by tests only.
package dbtest

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
)

const image = "postgres:18-alpine"

var (
	once      sync.Once
	dsn       string
	err       error
	container *postgres.PostgresContainer
)

// Terminate removes the shared container. Test packages call it from TestMain after m.Run so
// containers do not outlive the test binary when the testcontainers reaper is disabled.
func Terminate() {
	if container != nil {
		_ = testcontainers.TerminateContainer(container)
	}
}

// DSN returns a connection string for a throwaway PostgreSQL. It uses TEST_DATABASE_URL when
// set (CI service container), otherwise starts a container shared by the test binary, and
// skips the test when Docker is not available.
func DSN(t *testing.T) string {
	t.Helper()
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	testcontainers.SkipIfProviderIsNotHealthy(t)
	once.Do(func() {
		// Removed by Terminate (TestMain) or, as a fallback, by the testcontainers reaper.
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		container, err = postgres.Run(ctx, image,
			postgres.WithDatabase("tip_test"),
			postgres.WithUsername("tip"),
			postgres.WithPassword("tip"),
			postgres.BasicWaitStrategies(),
		)
		if err == nil {
			dsn, err = container.ConnectionString(ctx, "sslmode=disable")
		}
	})
	if err != nil {
		t.Skipf("postgres test container unavailable: %v", err)
	}
	return dsn
}
