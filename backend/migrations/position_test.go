package migrations_test

import (
	"testing"

	"github.com/pressly/goose/v3"

	"github.com/pavel-cpp/tip_website/backend/migrations"
)

// TestProjectPositionBackfill checks that migration 00008 keeps the newest-first order users see.
func TestProjectPositionBackfill(t *testing.T) {
	db := startPostgres(t)

	goose.SetBaseFS(migrations.FS)
	t.Cleanup(func() { goose.SetBaseFS(nil) })
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatalf("dialect: %v", err)
	}
	if err := goose.UpTo(db, ".", 7); err != nil {
		t.Fatalf("goose up to 7: %v", err)
	}
	for i, title := range []string{"old", "mid", "new"} {
		mustExec(t, db, `INSERT INTO projects (title, created_at) VALUES ($1, now() + make_interval(mins => $2))`, title, i)
	}
	if err := goose.Up(db, "."); err != nil {
		t.Fatalf("goose up: %v", err)
	}
	got := scalarString(t, db, `SELECT string_agg(title, ',' ORDER BY position) FROM projects`)
	if got != "new,mid,old" {
		t.Fatalf("order by position = %q, want new,mid,old", got)
	}
	// Down to the version before 00008, not "one step": later migrations must not change what is checked.
	if err := goose.DownTo(db, ".", 7); err != nil {
		t.Fatalf("goose down to 7: %v", err)
	}
	n := scalarString(t, db, `SELECT count(*)::text FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'position'`)
	if n != "0" {
		t.Fatal("position column survived the down migration")
	}
}
