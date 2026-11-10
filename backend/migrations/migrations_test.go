package migrations_test

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/pavel-cpp/tip_website/backend/migrations"
)

// startPostgres boots a throwaway PostgreSQL 18 and returns an open handle.
// The test is skipped when no healthy Docker daemon is available.
func startPostgres(t *testing.T) *sql.DB {
	t.Helper()
	testcontainers.SkipIfProviderIsNotHealthy(t)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	ctr, err := postgres.Run(ctx, "postgres:18-alpine",
		postgres.WithDatabase("tip"),
		postgres.WithUsername("tip"),
		postgres.WithPassword("tip"),
		postgres.BasicWaitStrategies(),
		testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").
			WithOccurrence(2).WithStartupTimeout(2*time.Minute)),
	)
	if err != nil {
		t.Skipf("cannot start postgres container (docker unavailable?): %v", err)
	}
	t.Cleanup(func() { _ = testcontainers.TerminateContainer(ctr) })

	dsn, err := ctr.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("connection string: %v", err)
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func tableExists(t *testing.T, db *sql.DB, name string) bool {
	t.Helper()
	var ok bool
	err := db.QueryRow(`SELECT to_regclass('public.' || $1) IS NOT NULL`, name).Scan(&ok)
	if err != nil {
		t.Fatalf("to_regclass(%s): %v", name, err)
	}
	return ok
}

// mustExec runs a statement that must succeed and returns nothing.
func mustExec(t *testing.T, db *sql.DB, q string, args ...any) {
	t.Helper()
	if _, err := db.Exec(q, args...); err != nil {
		t.Fatalf("exec %q: %v", q, err)
	}
}

// mustFail runs a statement that must be rejected by a constraint.
// The SQLSTATE class 23 (integrity constraint violation) is required, so
// typos in the statement itself are not mistaken for a constraint working.
func mustFail(t *testing.T, db *sql.DB, wantState, q string, args ...any) {
	t.Helper()
	_, err := db.Exec(q, args...)
	if err == nil {
		t.Fatalf("expected constraint violation %s for %q, got success", wantState, q)
	}
	if !strings.Contains(err.Error(), "SQLSTATE "+wantState) {
		t.Fatalf("expected SQLSTATE %s for %q, got: %v", wantState, q, err)
	}
}

func scalarString(t *testing.T, db *sql.DB, q string, args ...any) string {
	t.Helper()
	var s string
	if err := db.QueryRow(q, args...).Scan(&s); err != nil {
		t.Fatalf("query %q: %v", q, err)
	}
	return s
}

const (
	sqlCheck   = "23514"
	sqlUnique  = "23505"
	sqlForeign = "23503"
)

var allTables = []string{
	"users", "user_avatars", "permissions", "roles", "role_permissions", "user_roles",
	"authz_state", "projects", "project_placeholders", "project_contributors",
	"participants", "audit_log", "fonts",
}

func TestMigrations(t *testing.T) {
	db := startPostgres(t)

	goose.SetBaseFS(migrations.FS)
	t.Cleanup(func() { goose.SetBaseFS(nil) })
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatalf("dialect: %v", err)
	}
	if err := goose.Up(db, "."); err != nil {
		t.Fatalf("goose up: %v", err)
	}

	t.Run("tables exist", func(t *testing.T) {
		for _, tbl := range allTables {
			if !tableExists(t, db, tbl) {
				t.Errorf("table %s missing after up", tbl)
			}
		}
	})

	t.Run("seed data", func(t *testing.T) {
		var n int
		if err := db.QueryRow(`SELECT count(*) FROM roles WHERE is_system AND name IN ('admin','worker')`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 2 {
			t.Errorf("system roles = %d, want 2", n)
		}
		var epoch int64
		if err := db.QueryRow(`SELECT epoch FROM authz_state WHERE id = 1`).Scan(&epoch); err != nil {
			t.Fatal(err)
		}
		if epoch != 1 {
			t.Errorf("authz epoch = %d, want 1", epoch)
		}
		mustFail(t, db, sqlCheck, `INSERT INTO authz_state (id, epoch) VALUES (2, 1)`)
		mustFail(t, db, sqlUnique, `INSERT INTO authz_state (id, epoch) VALUES (1, 1)`)
	})

	newUser := func(t *testing.T, login string) string {
		t.Helper()
		return scalarString(t, db,
			`INSERT INTO users (login, display_name, password_hash) VALUES ($1, 'Name', 'hash') RETURNING id::text`, login)
	}
	newProject := func(t *testing.T, title string) string {
		t.Helper()
		return scalarString(t, db, `INSERT INTO projects (title) VALUES ($1) RETURNING id::text`, title)
	}

	t.Run("users", func(t *testing.T) {
		id := newUser(t, "alice.b-1_x")
		if got := scalarString(t, db, `SELECT locale || '/' || theme || '/' || color FROM users WHERE id = $1`, id); got != "ru/dark/#6cb4ff" {
			t.Errorf("defaults = %q", got)
		}
		mustFail(t, db, sqlUnique, `INSERT INTO users (login, display_name, password_hash) VALUES ('alice.b-1_x', 'N', 'h')`)
		for _, bad := range []string{"ab", "Alice", "has space", "тест1234", strings.Repeat("a", 33)} {
			mustFail(t, db, sqlCheck, `INSERT INTO users (login, display_name, password_hash) VALUES ($1, 'N', 'h')`, bad)
		}
		mustFail(t, db, sqlCheck, `INSERT INTO users (login, display_name, password_hash, locale) VALUES ('loc.user', 'N', 'h', 'en')`)
		mustFail(t, db, sqlCheck, `INSERT INTO users (login, display_name, password_hash, theme) VALUES ('thm.user', 'N', 'h', 'blue')`)
		mustFail(t, db, sqlCheck, `INSERT INTO users (login, display_name, password_hash, color) VALUES ('col.user', 'N', 'h', 'red')`)
		mustFail(t, db, sqlCheck, `INSERT INTO users (login, display_name, password_hash) VALUES ('empty.dn', '', 'h')`)
		mustExec(t, db, `INSERT INTO users (login, display_name, password_hash, locale, theme) VALUES ('uz.system', 'N', 'h', 'uz', 'system')`)
	})

	t.Run("fonts", func(t *testing.T) {
		sha := strings.Repeat("a", 64)
		id := newUser(t, "font.user")
		mustExec(t, db, `INSERT INTO fonts (name, format, sha256, bytes, created_by) VALUES ('F', 'ttf', $1, 10, $2)`, sha, id)
		mustFail(t, db, sqlUnique, `INSERT INTO fonts (name, format, sha256, bytes) VALUES ('G', 'otf', $1, 10)`, sha)
		other := strings.Repeat("b", 64)
		mustFail(t, db, sqlCheck, `INSERT INTO fonts (name, format, sha256, bytes) VALUES ('G', 'woff', $1, 10)`, other)
		mustFail(t, db, sqlCheck, `INSERT INTO fonts (name, format, sha256, bytes) VALUES ('', 'ttf', $1, 10)`, other)
		mustFail(t, db, sqlCheck, `INSERT INTO fonts (name, format, sha256, bytes) VALUES ('G', 'ttf', 'XYZ', 10)`)
		mustFail(t, db, sqlCheck, `INSERT INTO fonts (name, format, sha256, bytes) VALUES ('G', 'ttf', $1, 0)`, other)
		mustExec(t, db, `DELETE FROM users WHERE id = $1`, id)
		if got := scalarString(t, db, `SELECT COALESCE(created_by::text, 'null') FROM fonts WHERE sha256 = $1`, sha); got != "null" {
			t.Errorf("created_by after user delete = %q", got)
		}
	})

	t.Run("avatar size limit and cascade", func(t *testing.T) {
		id := newUser(t, "avatar.user")
		mustFail(t, db, sqlCheck,
			`INSERT INTO user_avatars (user_id, mime, data, sha256) VALUES ($1, 'image/jpeg', repeat('a', 262145)::bytea, 'x')`, id)
		mustExec(t, db, `INSERT INTO user_avatars (user_id, mime, data, sha256) VALUES ($1, 'image/jpeg', '\x00'::bytea, 'x')`, id)
		mustExec(t, db, `DELETE FROM users WHERE id = $1`, id)
		var n int
		if err := db.QueryRow(`SELECT count(*) FROM user_avatars WHERE user_id = $1`, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Errorf("avatar survived user deletion")
		}
	})

	t.Run("permission code format", func(t *testing.T) {
		mustExec(t, db, `INSERT INTO permissions (code, grp, description) VALUES ('participant.edit', 'g', 'd')`)
		for _, bad := range []string{"noDot", "Upper.case", "a.b.c", "a.", ".b", "a-b.c", "a.b1"} {
			mustFail(t, db, sqlCheck, `INSERT INTO permissions (code, grp, description) VALUES ($1, 'g', 'd')`, bad)
		}
	})

	t.Run("roles and role_permissions", func(t *testing.T) {
		mustFail(t, db, sqlUnique, `INSERT INTO roles (name) VALUES ('admin')`)
		mustFail(t, db, sqlCheck, `INSERT INTO roles (name) VALUES ('x')`)
		mustFail(t, db, sqlCheck, `INSERT INTO roles (name) VALUES ($1)`, strings.Repeat("n", 51))
		mustFail(t, db, sqlCheck, `INSERT INTO roles (name, description) VALUES ('long.desc', $1)`, strings.Repeat("d", 301))

		roleID := scalarString(t, db, `INSERT INTO roles (name) VALUES ('Senior') RETURNING id::text`)
		mustFail(t, db, sqlForeign, `INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'no.such')`, roleID)
		mustFail(t, db, sqlForeign,
			`INSERT INTO role_permissions (role_id, permission) VALUES ('00000000-0000-0000-0000-000000000000', 'participant.edit')`)
		mustExec(t, db, `INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'participant.edit')`, roleID)
		mustFail(t, db, sqlUnique, `INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'participant.edit')`, roleID)

		// Deleting a role cascades to its permission grants.
		mustExec(t, db, `DELETE FROM roles WHERE id = $1`, roleID)
		var n int
		if err := db.QueryRow(`SELECT count(*) FROM role_permissions WHERE role_id = $1`, roleID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Errorf("role_permissions survived role deletion")
		}

		// Deleting a permission cascades to grants as well.
		mustExec(t, db, `INSERT INTO permissions (code, grp, description) VALUES ('tmp.perm', 'g', 'd')`)
		roleID = scalarString(t, db, `INSERT INTO roles (name) VALUES ('Temp') RETURNING id::text`)
		mustExec(t, db, `INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'tmp.perm')`, roleID)
		mustExec(t, db, `DELETE FROM permissions WHERE code = 'tmp.perm'`)
		if err := db.QueryRow(`SELECT count(*) FROM role_permissions WHERE role_id = $1`, roleID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Errorf("role_permissions survived permission deletion")
		}
	})

	t.Run("user_roles restrict", func(t *testing.T) {
		uid := newUser(t, "assigned.user")
		rid := scalarString(t, db, `INSERT INTO roles (name) VALUES ('Assigned') RETURNING id::text`)
		mustExec(t, db, `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, uid, rid)
		mustFail(t, db, sqlUnique, `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, uid, rid)
		mustFail(t, db, "23001", `DELETE FROM roles WHERE id = $1`, rid) // restrict_violation
		// Removing the user releases the role.
		mustExec(t, db, `DELETE FROM users WHERE id = $1`, uid)
		mustExec(t, db, `DELETE FROM roles WHERE id = $1`, rid)
	})

	t.Run("projects", func(t *testing.T) {
		pid := newProject(t, "Contest")
		if got := scalarString(t, db, `SELECT status::text || '/' || next_number || '/' || version FROM projects WHERE id = $1`, pid); got != "active/1/1" {
			t.Errorf("defaults = %q", got)
		}
		mustFail(t, db, sqlCheck, `INSERT INTO projects (title) VALUES ('')`)
		mustFail(t, db, sqlCheck, `INSERT INTO projects (title) VALUES ($1)`, strings.Repeat("t", 121))
		// Image columns are all-or-none.
		mustFail(t, db, sqlCheck, `UPDATE projects SET image_sha256 = 'abc' WHERE id = $1`, pid)
		mustExec(t, db, `UPDATE projects SET image_sha256 = 'abc', image_name = 'a.jpg', image_mime = 'image/jpeg',
			image_w = 10, image_h = 10, image_bytes = 100 WHERE id = $1`, pid)
		mustFail(t, db, "22P02", `INSERT INTO projects (title, status) VALUES ('x', 'archived')`)
	})

	t.Run("project_placeholders", func(t *testing.T) {
		pid := newProject(t, "Placeholders")
		const ins = `INSERT INTO project_placeholders (project_id, key, font, size, stroke, color, stroke_color, x, y)
			VALUES ($1, $2, 'Inter', $3, $4, $5, '#000000', $6, 0)`
		mustExec(t, db, ins, pid, "number", 34, 2, "#FFFFFF", 5)
		mustFail(t, db, sqlUnique, ins, pid, "number", 34, 2, "#FFFFFF", 5)
		mustFail(t, db, sqlCheck, ins, pid, "email", 34, 2, "#FFFFFF", 5)
		mustFail(t, db, sqlCheck, ins, pid, "name", 5, 2, "#FFFFFF", 5)
		mustFail(t, db, sqlCheck, ins, pid, "name", 401, 2, "#FFFFFF", 5)
		mustFail(t, db, sqlCheck, ins, pid, "name", 34, 51, "#FFFFFF", 5)
		mustFail(t, db, sqlCheck, ins, pid, "name", 34, 2, "FFFFFF", 5)
		mustFail(t, db, sqlCheck, ins, pid, "name", 34, 2, "#FFFFFF", -1)
		mustExec(t, db, `DELETE FROM projects WHERE id = $1`, pid)
		var n int
		if err := db.QueryRow(`SELECT count(*) FROM project_placeholders WHERE project_id = $1`, pid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Errorf("placeholders survived project deletion")
		}
	})

	t.Run("participants", func(t *testing.T) {
		pid := newProject(t, "Participants")
		uid := newUser(t, "editor.user")
		const ins = `INSERT INTO participants (project_id, number, name, phone, updated_by) VALUES ($1, $2, $3, $4, $5)`
		mustExec(t, db, ins, pid, 1, "n", "p", uid)
		mustFail(t, db, sqlUnique, ins, pid, 1, "other", "p", uid)
		mustFail(t, db, sqlCheck, ins, pid, 0, "n", "p", uid)
		mustFail(t, db, sqlCheck, ins, pid, 2, strings.Repeat("n", 201), "p", uid)
		mustFail(t, db, sqlCheck, ins, pid, 2, "n", strings.Repeat("9", 41), uid)
		// The same number is fine in another project.
		pid2 := newProject(t, "Other")
		mustExec(t, db, ins, pid2, 1, "n", "p", uid)
		// Deleting the editor keeps the row and nulls the reference.
		mustExec(t, db, `DELETE FROM users WHERE id = $1`, uid)
		var nullUpdater bool
		if err := db.QueryRow(`SELECT bool_and(updated_by IS NULL) FROM participants`).Scan(&nullUpdater); err != nil {
			t.Fatal(err)
		}
		if !nullUpdater {
			t.Errorf("updated_by not nulled after user deletion")
		}
	})

	t.Run("audit", func(t *testing.T) {
		pid := newProject(t, "Audited")
		mustExec(t, db, `INSERT INTO audit_log (actor_login, action, project_id, ip) VALUES ('root', 'project.create', $1, '127.0.0.1')`, pid)
		mustExec(t, db, `DELETE FROM projects WHERE id = $1`, pid)
		var n int
		if err := db.QueryRow(`SELECT count(*) FROM audit_log WHERE project_id IS NULL AND action = 'project.create'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Errorf("audit row not preserved with null project_id")
		}
		mustFail(t, db, "23502", `INSERT INTO audit_log (action) VALUES ('x')`)
	})

	t.Run("down", func(t *testing.T) {
		if err := goose.DownTo(db, ".", 0); err != nil {
			t.Fatalf("goose down: %v", err)
		}
		for _, tbl := range allTables {
			if tableExists(t, db, tbl) {
				t.Errorf("table %s still exists after down", tbl)
			}
		}
		var typeCount int
		if err := db.QueryRow(`SELECT count(*) FROM pg_type WHERE typname = 'project_status'`).Scan(&typeCount); err != nil {
			t.Fatal(err)
		}
		if typeCount != 0 {
			t.Errorf("enum project_status still exists after down")
		}
		// Re-applying proves Down leaves nothing behind.
		if err := goose.Up(db, "."); err != nil {
			t.Fatalf("goose up after down: %v", err)
		}
	})
}
