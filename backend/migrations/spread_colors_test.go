package migrations_test

import (
	"fmt"
	"testing"

	"github.com/pressly/goose/v3"

	"github.com/pavel-cpp/tip_website/backend/migrations"
)

// TestSpreadSharedColors checks that migration 00007 gives users that share a palette colour distinct
// ones (oldest user keeps theirs) and leaves hand-picked colours alone.
func TestSpreadSharedColors(t *testing.T) {
	db := startPostgres(t)

	goose.SetBaseFS(migrations.FS)
	t.Cleanup(func() { goose.SetBaseFS(nil) })
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatalf("dialect: %v", err)
	}
	if err := goose.UpTo(db, ".", 6); err != nil {
		t.Fatalf("goose up to 6: %v", err)
	}
	for i := 0; i < 6; i++ {
		mustExec(t, db, `INSERT INTO users (login, display_name, password_hash, color, created_at)
			VALUES ($1, 'U', 'h', '#ff6b9d', now() + make_interval(secs => $2))`, fmt.Sprintf("user%02d", i), i)
	}
	mustExec(t, db, `INSERT INTO users (login, display_name, password_hash, color) VALUES ('custom', 'U', 'h', '#112233')`)

	if err := goose.Up(db, "."); err != nil {
		t.Fatalf("goose up: %v", err)
	}
	if got := scalarString(t, db, `SELECT color FROM users WHERE login = 'user00'`); got != "#ff6b9d" {
		t.Fatalf("oldest user lost their colour: %q", got)
	}
	if got := scalarString(t, db, `SELECT color FROM users WHERE login = 'custom'`); got != "#112233" {
		t.Fatalf("hand-picked colour was changed: %q", got)
	}
	if n := scalarString(t, db, `SELECT count(DISTINCT color)::text FROM users WHERE login LIKE 'user%'`); n != "6" {
		t.Fatalf("six users hold %s distinct colours, want 6", n)
	}
}
