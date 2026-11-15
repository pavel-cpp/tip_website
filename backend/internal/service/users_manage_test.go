package service

import (
	"testing"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// A user.manage holder without role.manage must not be able to take over, edit or switch off
// an account that has more permissions than they do.
func TestManageOnlyOutranksTargets(t *testing.T) {
	r := newRig(t, rigOpts{})
	off, name := false, "Hacked"
	r.db.addUser("u-admin2", "admin2", "pw-pw-pw-pw", "role-admin")
	// The manager holds exactly the worker permissions plus user.manage.
	mgr := acctActorWith("u-mgr", domain.PermUserManage, domain.PermProjectView, domain.PermParticipantView)

	t.Run("admin target is forbidden everywhere", func(t *testing.T) {
		if _, err := r.users.ResetPassword(ctx, mgr, "u-admin"); !isErr(err, domain.ErrForbidden) {
			t.Errorf("reset: %v", err)
		}
		if _, err := r.users.UpdateUser(ctx, mgr, "u-admin2", UserUpdate{IsActive: &off}); !isErr(err, domain.ErrForbidden) {
			t.Errorf("deactivate: %v", err)
		}
		if _, err := r.users.UpdateUser(ctx, mgr, "u-admin2", UserUpdate{DisplayName: &name}); !isErr(err, domain.ErrForbidden) {
			t.Errorf("rename: %v", err)
		}
		if _, err := r.users.SetRoles(ctx, mgr, "u-admin2", []string{"role-worker"}); !isErr(err, domain.ErrForbidden) {
			t.Errorf("set roles: %v", err)
		}
		if !r.db.users["u-admin"].active || r.db.users["u-admin"].hash != "hash:admin-pass" || !r.db.users["u-admin2"].active {
			t.Fatal("admin accounts must be untouched")
		}
		if !r.store.cutoffs["u-admin"].IsZero() || len(r.revoked) != 0 {
			t.Fatal("nothing may be revoked")
		}
	})
	t.Run("equal or lower permissions are allowed", func(t *testing.T) {
		if _, err := r.users.ResetPassword(ctx, mgr, "u-worker"); err != nil {
			t.Errorf("reset worker: %v", err)
		}
		if _, err := r.users.UpdateUser(ctx, mgr, "u-worker", UserUpdate{DisplayName: &name}); err != nil {
			t.Errorf("rename worker: %v", err)
		}
	})
	t.Run("one missing permission is enough to refuse", func(t *testing.T) {
		weak := acctActorWith("u-weak", domain.PermUserManage, domain.PermProjectView)
		if _, err := r.users.ResetPassword(ctx, weak, "u-worker"); !isErr(err, domain.ErrForbidden) {
			t.Errorf("reset: %v", err)
		}
	})
	t.Run("role.manage may act on anyone, self is always allowed", func(t *testing.T) {
		full := acctActorWith("u-root", domain.PermUserManage, domain.PermRoleManage)
		if _, err := r.users.ResetPassword(ctx, full, "u-admin2"); err != nil {
			t.Errorf("full: %v", err)
		}
		if _, err := r.users.UpdateUser(ctx, acctActorWith("u-admin", domain.PermUserManage), "u-admin", UserUpdate{DisplayName: &name}); err != nil {
			t.Errorf("self: %v", err)
		}
	})
}
