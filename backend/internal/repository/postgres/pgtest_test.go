package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"sync/atomic"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" driver

	"github.com/pavel-cpp/tip_website/backend/internal/platform/db"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/dbtest"
	"github.com/pavel-cpp/tip_website/backend/migrations"
)

var dbSeq atomic.Int64

// newMigratedDB creates an isolated, fully migrated database on the shared test server so
// repository tests never see each other's rows. The test is skipped without Docker.
func newMigratedDB(t *testing.T) *sql.DB {
	t.Helper()
	ctx := context.Background()
	base := dbtest.DSN(t)
	admin, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close() }()

	name := fmt.Sprintf("repo_%d_%d", os.Getpid(), dbSeq.Add(1))
	if _, err := admin.ExecContext(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create database: %v", err)
	}
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	d, err := db.Open(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = d.Close()
		a, err := sql.Open("pgx", base)
		if err != nil {
			return
		}
		defer func() { _ = a.Close() }()
		_, _ = a.ExecContext(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
	})
	if err := db.Migrate(ctx, d, migrations.FS, "."); err != nil {
		t.Fatal(err)
	}
	return d
}
