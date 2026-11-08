package service

import (
	"errors"
	"slices"
	"testing"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

var roleAdminActor = actorWith("u-admin", domain.PermRoleManage)

func TestRolesRequirePermission(t *testing.T) {
	r := newRig(t, rigOpts{})
	nobody := actorWith("x", domain.PermUserManage)
	if _, err := r.roles.Catalog(nobody); !isErr(err, domain.ErrForbidden) {
		t.Errorf("catalog: %v", err)
	}
	if _, err := r.roles.List(ctx, nobody); !isErr(err, domain.ErrForbidden) {
		t.Errorf("list: %v", err)
	}
	if _, err := r.roles.Get(ctx, nobody, "role-worker"); !isErr(err, domain.ErrForbidden) {
		t.Errorf("get: %v", err)
	}
	if _, err := r.roles.Create(ctx, nobody, RoleCreate{Name: "Abc"}); !isErr(err, domain.ErrForbidden) {
		t.Errorf("create: %v", err)
	}
	if _, err := r.roles.Update(ctx, nobody, "role-worker", RoleUpdate{}); !isErr(err, domain.ErrForbidden) {
		t.Errorf("update: %v", err)
	}
	if err := r.roles.Delete(ctx, nobody, "role-worker"); !isErr(err, domain.ErrForbidden) {
		t.Errorf("delete: %v", err)
	}
}

func TestCatalogAndList(t *testing.T) {
	r := newRig(t, rigOpts{})
	cat, err := r.roles.Catalog(roleAdminActor)
	if err != nil || len(cat) != len(domain.AllPermissions()) {
		t.Fatalf("cat=%d err=%v", len(cat), err)
	}
	list, err := r.roles.List(ctx, roleAdminActor)
	if err != nil || len(list) != 2 {
		t.Fatalf("list=%+v err=%v", list, err)
	}
	for _, role := range list {
		if role.UserCount != 1 {
			t.Errorf("%s user count = %d", role.Name, role.UserCount)
		}
	}
	d, err := r.roles.Get(ctx, roleAdminActor, "role-worker")
	if err != nil || d.Role.UserCount != 1 || len(d.Users) != 1 || d.Users[0].ID != "u-worker" {
		t.Fatalf("detail=%+v err=%v", d, err)
	}
	if _, err := r.roles.Get(ctx, roleAdminActor, "ghost"); !isErr(err, domain.ErrNotFound) {
		t.Errorf("not found: %v", err)
	}
}

func TestCreateRoleAddsDependenciesWithoutEpochBump(t *testing.T) {
	r := newRig(t, rigOpts{})
	role, err := r.roles.Create(ctx, roleAdminActor, RoleCreate{Name: " Senior ", Description: "d", Permissions: []string{"participant.delete"}})
	if err != nil {
		t.Fatal(err)
	}
	want := []domain.Permission{domain.PermProjectView, domain.PermParticipantView, domain.PermParticipantDelete}
	if role.Name != "Senior" || !slices.Equal(role.Permissions, want) || role.IsSystem {
		t.Fatalf("role = %+v", role)
	}
	if r.db.bumps != 0 {
		t.Fatal("creating an unassigned role must not bump the epoch")
	}
	if got := r.audit.actions(); got[len(got)-1] != "role.create" {
		t.Fatalf("audit = %v", got)
	}
}

func TestCreateRoleValidation(t *testing.T) {
	r := newRig(t, rigOpts{})
	_, err := r.roles.Create(ctx, roleAdminActor, RoleCreate{Name: "x", Permissions: []string{"nope.nope"}})
	var ve *domain.ValidationError
	if !errors.As(err, &ve) || len(ve.Fields) != 2 {
		t.Fatalf("fields: %v", err)
	}
	if _, err := r.roles.Create(ctx, roleAdminActor, RoleCreate{Name: RolePasswordChange}); !isErr(err, domain.ErrValidation) {
		t.Errorf("reserved name: %v", err)
	}
	if _, err := r.roles.Create(ctx, roleAdminActor, RoleCreate{Name: "worker"}); !isErr(err, domain.ErrValidation) {
		t.Errorf("duplicate name: %v", err)
	}
}

func TestUpdateRole(t *testing.T) {
	r := newRig(t, rigOpts{})
	created, _ := r.roles.Create(ctx, roleAdminActor, RoleCreate{Name: "Viewer", Permissions: []string{"project.view"}})
	r.db.bumps = 0
	before := r.epoch.Load()

	perms := []string{"participant.edit"}
	role, err := r.roles.Update(ctx, roleAdminActor, created.ID, RoleUpdate{Permissions: &perms})
	if err != nil {
		t.Fatal(err)
	}
	want := []domain.Permission{domain.PermProjectView, domain.PermParticipantView, domain.PermParticipantEdit}
	if !slices.Equal(role.Permissions, want) || role.Name != "Viewer" {
		t.Fatalf("role = %+v", role)
	}
	if r.db.bumps != 1 || r.epoch.Load() != before+1 {
		t.Fatalf("bumps=%d epoch=%d", r.db.bumps, r.epoch.Load())
	}
	e := r.audit.entries[len(r.audit.entries)-1]
	if e.Action != "role.update" || len(e.Meta["addedPermissions"].([]string)) != 2 || len(e.Meta["removedPermissions"].([]string)) != 0 {
		t.Fatalf("audit = %+v", e)
	}

	// A change that alters nothing leaves the epoch alone.
	same := "same-desc"
	if _, err := r.roles.Update(ctx, roleAdminActor, created.ID, RoleUpdate{Description: &same}); err != nil {
		t.Fatal(err)
	}
	if r.db.bumps != 1 {
		t.Fatal("description-only change must not bump the epoch")
	}
	// A rename does, because role names travel in tokens.
	name := "Renamed"
	if _, err := r.roles.Update(ctx, roleAdminActor, created.ID, RoleUpdate{Name: &name}); err != nil {
		t.Fatal(err)
	}
	if r.db.bumps != 2 {
		t.Fatal("rename must bump the epoch")
	}
}

func TestUpdateSystemRoles(t *testing.T) {
	r := newRig(t, rigOpts{})
	d := "x"
	if _, err := r.roles.Update(ctx, roleAdminActor, "role-admin", RoleUpdate{Description: &d}); !isErr(err, domain.ErrRoleSystem) {
		t.Errorf("admin: %v", err)
	}
	// worker: permissions editable, name locked.
	perms := []string{"project.view"}
	if _, err := r.roles.Update(ctx, roleAdminActor, "role-worker", RoleUpdate{Permissions: &perms}); err != nil {
		t.Errorf("worker perms: %v", err)
	}
	name := "operators"
	if _, err := r.roles.Update(ctx, roleAdminActor, "role-worker", RoleUpdate{Name: &name}); !isErr(err, domain.ErrValidation) {
		t.Errorf("worker rename: %v", err)
	}
	if _, err := r.roles.Update(ctx, roleAdminActor, "ghost", RoleUpdate{}); !isErr(err, domain.ErrNotFound) {
		t.Errorf("not found: %v", err)
	}
}

func TestDeleteRole(t *testing.T) {
	r := newRig(t, rigOpts{})
	created, _ := r.roles.Create(ctx, roleAdminActor, RoleCreate{Name: "Temp"})
	r.db.assign["u-worker"] = append(r.db.assign["u-worker"], created.ID)

	err := r.roles.Delete(ctx, roleAdminActor, created.ID)
	var de *domain.Error
	if !isErr(err, domain.ErrRoleInUse) || !errors.As(err, &de) || de.Details["users"].([]string)[0] != "u-worker" {
		t.Fatalf("in use: %v", err)
	}
	r.db.assign["u-worker"] = []string{"role-worker"}
	if err := r.roles.Delete(ctx, roleAdminActor, created.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := r.db.roles[created.ID]; ok {
		t.Fatal("role still present")
	}
	if got := r.audit.actions(); got[len(got)-1] != "role.delete" {
		t.Fatalf("audit = %v", got)
	}
	for _, id := range []string{"role-admin", "role-worker"} {
		if err := r.roles.Delete(ctx, roleAdminActor, id); !isErr(err, domain.ErrRoleSystem) {
			t.Errorf("%s: %v", id, err)
		}
	}
	if err := r.roles.Delete(ctx, roleAdminActor, "ghost"); !isErr(err, domain.ErrNotFound) {
		t.Errorf("not found: %v", err)
	}
}

func TestSyncPermissions(t *testing.T) {
	r := newRig(t, rigOpts{})
	r.db.roles["role-admin"].Permissions = []domain.Permission{domain.PermProjectView}
	r.db.roles["role-worker"].Permissions = nil
	before := r.epoch.Load()

	if err := r.roles.SyncPermissions(ctx); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(r.db.roles["role-admin"].Permissions, domain.AllPermissions()) {
		t.Fatal("admin must hold the whole catalog")
	}
	if !slices.Equal(r.db.roles["role-worker"].Permissions, domain.DefaultWorkerPermissions()) {
		t.Fatalf("worker defaults = %v", r.db.roles["role-worker"].Permissions)
	}
	if r.epoch.Load() != before+1 {
		t.Fatal("epoch must grow after a change")
	}

	// A second run changes nothing and leaves customised worker permissions alone.
	custom := []domain.Permission{domain.PermProjectView}
	r.db.roles["role-worker"].Permissions = custom
	if err := r.roles.SyncPermissions(ctx); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(r.db.roles["role-worker"].Permissions, custom) || r.epoch.Load() != before+1 {
		t.Fatal("idempotent sync must not touch customised roles or the epoch")
	}
}
