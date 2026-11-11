// Package dbtest hands integration tests a PostgreSQL DSN. It is imported by tests only.
package dbtest

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" driver for the per-binary database
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
)

const image = "postgres:18-alpine"

var (
	once      sync.Once
	dsn       string
	err       error
	container *postgres.PostgresContainer

	ownOnce sync.Once
	ownDSN  string
	ownErr  error
	ownName string
	ownBase string
)

// Terminate removes the shared container. Test packages call it from TestMain after m.Run so
// containers do not outlive the test binary when the testcontainers reaper is disabled.
func Terminate() {
	if container != nil {
		_ = testcontainers.TerminateContainer(container)
	}
	if ownName != "" {
		if d, err := sql.Open("pgx", ownBase); err == nil {
			_, _ = d.Exec("DROP DATABASE IF EXISTS " + ownName + " WITH (FORCE)")
			_ = d.Close()
		}
	}
}

// ownDatabase creates a database that only this test binary uses on the server named by base. Test packages run as
// separate processes against the same CI service container; without this they would migrate, truncate and roll back
// the same schema at the same time.
func ownDatabase(base string) (string, error) {
	ownOnce.Do(func() {
		admin, err := sql.Open("pgx", base)
		if err != nil {
			ownErr = err
			return
		}
		defer func() { _ = admin.Close() }()
		name := fmt.Sprintf("tip_test_%d", os.Getpid())
		if _, err := admin.Exec("CREATE DATABASE " + name); err != nil {
			ownErr = fmt.Errorf("create test database: %w", err)
			return
		}
		u, err := url.Parse(base)
		if err != nil {
			ownErr = err
			return
		}
		u.Path = "/" + name
		ownName, ownBase, ownDSN = name, base, u.String()
	})
	return ownDSN, ownErr
}

// DSN returns a connection string for a throwaway PostgreSQL. It uses the server in TEST_DATABASE_URL when
// set (CI service container; every test binary gets its own database there), otherwise starts a container shared by the test binary, and
// skips the test when Docker is not available.
func DSN(t *testing.T) string {
	t.Helper()
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		d, err := ownDatabase(v)
		if err != nil {
			t.Fatalf("test database: %v", err)
		}
		return d
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
