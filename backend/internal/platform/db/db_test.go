package db

import (
	"context"
	"testing"
	"testing/fstest"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/platform/dbtest"
)

func TestOpenFailsFastOnUnreachableServer(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := Open(ctx, "postgres://u:p@127.0.0.1:1/x?connect_timeout=1"); err == nil {
		t.Fatal("expected an error for an unreachable server")
	}
}

func TestMigrateBadDir(t *testing.T) {
	// fs.Sub accepts any valid path, so an empty dir surfaces from goose; use an invalid path.
	if err := Migrate(context.Background(), nil, fstest.MapFS{}, "../bad"); err == nil {
		t.Fatal("expected an error for an invalid directory")
	}
}

func TestMigrateAndPool(t *testing.T) {
	ctx := context.Background()
	d, err := Open(ctx, dbtest.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if got := d.Stats().MaxOpenConnections; got != maxOpenConns {
		t.Errorf("max open = %d", got)
	}
	fsys := fstest.MapFS{
		"migrations/00001_t.sql": {Data: []byte("-- +goose Up\nCREATE TABLE IF NOT EXISTS dbtest_migrate (id int);\n-- +goose Down\nDROP TABLE dbtest_migrate;\n")},
	}
	for range 2 { // second run must be a no-op
		if err := Migrate(ctx, d, fsys, "migrations"); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	if err := d.QueryRowContext(ctx, "SELECT count(*) FROM dbtest_migrate").Scan(&n); err != nil {
		t.Fatal(err)
	}
}
