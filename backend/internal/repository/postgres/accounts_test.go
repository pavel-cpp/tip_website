package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/db"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/dbtest"
	"github.com/pavel-cpp/tip_website/backend/migrations"
)

var (
	migrateOnce sync.Once
	migrateErr  error
)

// accountsDB returns a migrated pool with the user/role tables cleaned of test data.
func accountsDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := dbtest.DSN(t)
	ctx := context.Background()
	pool, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pool.Close() })
	migrateOnce.Do(func() { migrateErr = db.Migrate(ctx, pool, migrations.FS, ".") })
	if migrateErr != nil {
		t.Fatal(migrateErr)
	}
	for _, q := range []string{
		`DELETE FROM user_roles`, `DELETE FROM user_avatars`, `DELETE FROM users`,
		`DELETE FROM roles WHERE NOT is_system`, `DELETE FROM role_permissions`,
		`UPDATE authz_state SET epoch = 1`,
	} {
		if _, err := pool.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	return pool
}

func newID() string { return uuid.Must(uuid.NewV7()).String() }

var bg = context.Background()

func mkUser(t *testing.T, r *UserRepo, login string, roleIDs ...string) string {
	t.Helper()
	id := newID()
	if err := r.Create(bg, domain.NewUser{ID: id, Login: login, DisplayName: login, Color: "#6cb4ff",
		PasswordHash: "hash", PasswordTemporary: true, CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if err := r.SetRoles(bg, id, roleIDs); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestSyncAndRoleLookup(t *testing.T) {
	pool := accountsDB(t)
	roles := NewRoleRepo(pool)
	changed, err := roles.UpsertCatalog(bg, domain.Catalog())
	if err != nil || !changed {
		t.Fatalf("first upsert changed=%v err=%v", changed, err)
	}
	if changed, err = roles.UpsertCatalog(bg, domain.Catalog()); err != nil || changed {
		t.Fatalf("second upsert changed=%v err=%v", changed, err)
	}
	admin, err := roles.GetByName(bg, domain.RoleAdmin)
	if err != nil || !admin.IsSystem {
		t.Fatalf("admin = %+v %v", admin, err)
	}
	if ch, err := roles.SetPermissions(bg, admin.ID, domain.AllPermissions()); err != nil || !ch {
		t.Fatalf("set admin perms: %v %v", ch, err)
	}
	if ch, err := roles.SetPermissions(bg, admin.ID, domain.AllPermissions()); err != nil || ch {
		t.Fatalf("idempotent set: %v %v", ch, err)
	}
	got, _ := roles.Get(bg, admin.ID)
	if len(got.Permissions) != len(domain.AllPermissions()) || got.Permissions[0] != domain.PermProjectView {
		t.Fatalf("admin perms = %v", got.Permissions)
	}

	// A code that left the catalog is pruned together with its role links.
	if _, err := pool.ExecContext(bg, `INSERT INTO permissions VALUES ('old.thing', 'x', 'y')`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.ExecContext(bg, `INSERT INTO role_permissions SELECT id, 'old.thing' FROM roles WHERE name = 'worker'`); err != nil {
		t.Fatal(err)
	}
	if changed, err = roles.UpsertCatalog(bg, domain.Catalog()); err != nil || !changed {
		t.Fatalf("prune changed=%v err=%v", changed, err)
	}
	worker, _ := roles.GetByName(bg, domain.RoleWorker)
	if len(worker.Permissions) != 0 {
		t.Fatalf("worker perms = %v", worker.Permissions)
	}
	if _, err := roles.GetByName(bg, "ghost"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal(err)
	}
	if _, err := roles.Get(bg, "not-a-uuid"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("malformed id: %v", err)
	}
}

func TestRoleCRUD(t *testing.T) {
	pool := accountsDB(t)
	roles, users := NewRoleRepo(pool), NewUserRepo(pool)
	if _, err := roles.UpsertCatalog(bg, domain.Catalog()); err != nil {
		t.Fatal(err)
	}
	ro := domain.Role{ID: newID(), Name: "Senior", Description: "d",
		Permissions: []domain.Permission{domain.PermProjectView, domain.PermParticipantView}}
	if err := roles.Create(bg, ro); err != nil {
		t.Fatal(err)
	}
	if err := roles.Create(bg, domain.Role{ID: newID(), Name: "Senior"}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("duplicate: %v", err)
	}
	uid := mkUser(t, users, "alice", ro.ID)

	got, err := roles.Get(bg, ro.ID)
	if err != nil || got.UserCount != 1 || len(got.Permissions) != 2 || got.IsSystem {
		t.Fatalf("got = %+v %v", got, err)
	}
	ro.Description, ro.Permissions = "new", []domain.Permission{domain.PermProjectView}
	if err := roles.Update(bg, ro); err != nil {
		t.Fatal(err)
	}
	got, _ = roles.Get(bg, ro.ID)
	if got.Description != "new" || len(got.Permissions) != 1 {
		t.Fatalf("after update = %+v", got)
	}
	if err := roles.Update(bg, domain.Role{ID: newID(), Name: "Nobody"}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("update missing: %v", err)
	}
	list, err := roles.List(bg)
	if err != nil || len(list) != 3 {
		t.Fatalf("list = %d %v", len(list), err)
	}
	many, err := roles.GetMany(bg, []string{ro.ID, newID()})
	if err != nil || len(many) != 1 {
		t.Fatalf("many = %v %v", many, err)
	}
	members, err := roles.Users(bg, ro.ID)
	if err != nil || len(members) != 1 || members[0].ID != uid {
		t.Fatalf("members = %+v %v", members, err)
	}

	if err := roles.Delete(bg, ro.ID); !errors.Is(err, domain.ErrRoleInUse) {
		t.Fatalf("delete in use: %v", err)
	}
	if err := users.SetRoles(bg, uid, nil); err != nil {
		t.Fatal(err)
	}
	if err := roles.Delete(bg, ro.ID); err != nil {
		t.Fatal(err)
	}
	if err := roles.Delete(bg, ro.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("delete twice: %v", err)
	}
}

func TestUserLifecycle(t *testing.T) {
	pool := accountsDB(t)
	roles, users := NewRoleRepo(pool), NewUserRepo(pool)
	if _, err := roles.UpsertCatalog(bg, domain.Catalog()); err != nil {
		t.Fatal(err)
	}
	worker, _ := roles.GetByName(bg, domain.RoleWorker)
	if _, err := roles.SetPermissions(bg, worker.ID, domain.DefaultWorkerPermissions()); err != nil {
		t.Fatal(err)
	}
	extra := domain.Role{ID: newID(), Name: "Printer", Permissions: []domain.Permission{domain.PermProjectView, domain.PermParticipantImport}}
	if err := roles.Create(bg, extra); err != nil {
		t.Fatal(err)
	}
	id := mkUser(t, users, "bob", worker.ID, extra.ID)

	if err := users.Create(bg, domain.NewUser{ID: newID(), Login: "bob", DisplayName: "x", Color: "#000000", PasswordHash: "h"}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("duplicate login: %v", err)
	}
	rec, err := users.GetByLogin(bg, "bob")
	if err != nil || rec.ID != id || rec.PasswordHash != "hash" || !rec.PasswordTemporary || !rec.IsActive ||
		rec.Locale != domain.LocaleRU || rec.Theme != domain.ThemeDark || rec.LastLoginAt != nil {
		t.Fatalf("rec = %+v %v", rec, err)
	}
	if len(rec.Roles) != 2 || rec.Roles[0].Name != "Printer" {
		t.Fatalf("roles = %+v", rec.Roles)
	}
	// Union of both roles, canonical order, no duplicates.
	if len(rec.Permissions) != 7 || rec.Permissions[0] != domain.PermProjectView {
		t.Fatalf("perms = %v", rec.Permissions)
	}

	name, color, loc, theme := "Bobby", "#aabbcc", domain.LocaleUZ, domain.ThemeLight
	if err := users.UpdateProfile(bg, id, domain.ProfilePatch{DisplayName: &name, Color: &color, Locale: &loc, Theme: &theme}); err != nil {
		t.Fatal(err)
	}
	if err := users.UpdateProfile(bg, id, domain.ProfilePatch{}); err != nil {
		t.Fatal(err)
	}
	if err := users.SetPassword(bg, id, "hash2", false); err != nil {
		t.Fatal(err)
	}
	if err := users.SetActive(bg, id, false); err != nil {
		t.Fatal(err)
	}
	at := time.Now().UTC().Truncate(time.Millisecond)
	if err := users.TouchLastLogin(bg, id, at); err != nil {
		t.Fatal(err)
	}
	rec, _ = users.GetByID(bg, id)
	if rec.DisplayName != "Bobby" || rec.Color != "#aabbcc" || rec.Locale != domain.LocaleUZ || rec.Theme != domain.ThemeLight ||
		rec.PasswordHash != "hash2" || rec.PasswordTemporary || rec.IsActive || rec.LastLoginAt == nil || !rec.LastLoginAt.Equal(at) {
		t.Fatalf("updated = %+v", rec)
	}

	for _, err := range []error{
		users.UpdateProfile(bg, newID(), domain.ProfilePatch{DisplayName: &name}),
		users.SetPassword(bg, newID(), "h", false),
		users.SetActive(bg, "garbage", true),
		users.TouchLastLogin(bg, newID(), at),
	} {
		if !errors.Is(err, domain.ErrNotFound) {
			t.Errorf("missing user: %v", err)
		}
	}
	if _, err := users.GetByID(bg, "garbage"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("garbage id: %v", err)
	}

	mkUser(t, users, "carol", worker.ID)
	list, err := users.List(bg)
	if err != nil || len(list) != 2 || list[0].Login != "bob" || len(list[0].Roles) != 2 || len(list[1].Permissions) != 6 {
		t.Fatalf("list = %+v %v", list, err)
	}
}

func TestAvatars(t *testing.T) {
	pool := accountsDB(t)
	users := NewUserRepo(pool)
	id := mkUser(t, users, "dave")
	if _, err := users.GetAvatar(bg, id); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal(err)
	}
	av := domain.Avatar{MIME: "image/jpeg", Data: []byte("jpegdata"), SHA256: "abc123"}
	if err := users.PutAvatar(bg, id, av, time.Now()); err != nil {
		t.Fatal(err)
	}
	av2 := domain.Avatar{MIME: "image/jpeg", Data: []byte("other"), SHA256: "def456"}
	if err := users.PutAvatar(bg, id, av2, time.Now()); err != nil {
		t.Fatal(err)
	}
	got, err := users.GetAvatar(bg, id)
	if err != nil || string(got.Data) != "other" || got.SHA256 != "def456" {
		t.Fatalf("got = %+v %v", got, err)
	}
	if rec, _ := users.GetByID(bg, id); rec.AvatarSHA != "def456" {
		t.Fatalf("record avatar sha = %q", rec.AvatarSHA)
	}
	if err := users.PutAvatar(bg, newID(), av, time.Now()); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("avatar for missing user: %v", err)
	}
	if err := users.DeleteAvatar(bg, id); err != nil {
		t.Fatal(err)
	}
	if err := users.DeleteAvatar(bg, id); err != nil {
		t.Fatal(err)
	}
	if _, err := users.GetAvatar(bg, id); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal(err)
	}
}

func TestCountActiveAdmins(t *testing.T) {
	pool := accountsDB(t)
	roles, users := NewRoleRepo(pool), NewUserRepo(pool)
	admin, _ := roles.GetByName(bg, domain.RoleAdmin)
	worker, _ := roles.GetByName(bg, domain.RoleWorker)
	a1 := mkUser(t, users, "adm1", admin.ID)
	mkUser(t, users, "adm2", admin.ID, worker.ID)
	mkUser(t, users, "wrk", worker.ID)
	count := func() int {
		n, err := users.CountActiveAdmins(bg)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	if count() != 2 {
		t.Fatalf("count = %d", count())
	}
	if err := users.SetActive(bg, a1, false); err != nil {
		t.Fatal(err)
	}
	if count() != 1 {
		t.Fatalf("count = %d", count())
	}
}

func TestEpochAndTransactions(t *testing.T) {
	pool := accountsDB(t)
	authz, tx := NewAuthzRepo(pool), NewTxManager(pool)
	if e, err := authz.Epoch(bg); err != nil || e != 1 {
		t.Fatalf("epoch = %d %v", e, err)
	}
	// A bump inside a rolled-back transaction disappears.
	boom := errors.New("boom")
	err := tx.Do(bg, func(ctx context.Context) error {
		if e, err := authz.BumpEpoch(ctx); err != nil || e != 2 {
			t.Fatalf("bump = %d %v", e, err)
		}
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatal(err)
	}
	if e, _ := authz.Epoch(bg); e != 1 {
		t.Fatalf("epoch after rollback = %d", e)
	}
	if err := tx.Do(bg, func(ctx context.Context) error {
		_, err := authz.BumpEpoch(ctx)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if e, _ := authz.Epoch(bg); e != 2 {
		t.Fatalf("epoch after commit = %d", e)
	}
}

func TestRepositoriesJoinTransaction(t *testing.T) {
	pool := accountsDB(t)
	users, tx := NewUserRepo(pool), NewTxManager(pool)
	id := newID()
	err := tx.Do(bg, func(ctx context.Context) error {
		if err := users.Create(ctx, domain.NewUser{ID: id, Login: "txuser", DisplayName: "t", Color: "#000000", PasswordHash: "h"}); err != nil {
			return err
		}
		if _, err := users.GetByID(ctx, id); err != nil {
			return fmt.Errorf("not visible inside the tx: %w", err)
		}
		return errors.New("abort")
	})
	if err == nil {
		t.Fatal("expected abort")
	}
	if _, err := users.GetByID(bg, id); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("rolled back user visible: %v", err)
	}
}
