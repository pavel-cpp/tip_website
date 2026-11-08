package migrations_test

import (
	"fmt"
	"testing"

	"github.com/pressly/goose/v3"

	"github.com/pavel-cpp/tip_website/backend/migrations"
)

// TestPaletteBackfill checks that users still on the old default colour are spread over the palette
// by migration 00006 while an explicitly chosen colour is left alone.
func TestPaletteBackfill(t *testing.T) {
	db := startPostgres(t)

	goose.SetBaseFS(migrations.FS)
	t.Cleanup(func() { goose.SetBaseFS(nil) })
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatalf("dialect: %v", err)
	}
	if err := goose.UpTo(db, ".", 5); err != nil {
		t.Fatalf("goose up to 5: %v", err)
	}
	for i := 0; i < 30; i++ {
		mustExec(t, db, `INSERT INTO users (login, display_name, password_hash) VALUES ($1, 'U', 'h')`, fmt.Sprintf("user%02d", i))
	}
	mustExec(t, db, `UPDATE users SET color = '#112233' WHERE login = 'user00'`)
	if err := goose.Up(db, "."); err != nil {
		t.Fatalf("goose up: %v", err)
	}
	if got := scalarString(t, db, `SELECT color FROM users WHERE login = 'user00'`); got != "#112233" {
		t.Fatalf("explicitly chosen colour was overwritten: %q", got)
	}
	if n := scalarString(t, db, `SELECT count(DISTINCT color)::text FROM users`); n == "1" || n == "0" {
		t.Fatalf("users still share %s colour(s)", n)
	}
	outside := `SELECT count(*)::text FROM users WHERE color NOT IN
		('#ff6b9d','#ffb84d','#3ddc97','#6cb4ff','#b18cff','#ff9559','#112233')`
	if n := scalarString(t, db, outside); n != "0" {
		t.Fatalf("%s users got a colour outside the palette", n)
	}
}
