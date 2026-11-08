package service

import (
	"bytes"
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

func acctActorWith(id string, perms ...domain.Permission) domain.Actor {
	return domain.Actor{UserID: id, Perms: domain.NewPermissionSet(perms...)}
}

var ctx = context.Background()

func TestProfileUpdate(t *testing.T) {
	r := newRig(t, rigOpts{})
	a := acctActorWith("u-worker")
	name, color, loc, theme := "  New Name ", "#112233", "uz", "light"
	p, err := r.users.UpdateProfile(ctx, a, ProfileUpdate{DisplayName: &name, Color: &color, Locale: &loc, Theme: &theme})
	if err != nil {
		t.Fatal(err)
	}
	if p.User.DisplayName != "New Name" || p.User.Color != "#112233" || p.User.Locale != domain.LocaleUZ || p.User.Theme != domain.ThemeLight {
		t.Fatalf("profile = %+v", p.User)
	}
	if len(p.Permissions) != 2 {
		t.Fatalf("permissions = %v", p.Permissions)
	}
}

func TestProfileUpdateValidation(t *testing.T) {
	r := newRig(t, rigOpts{})
	bad, color, loc, theme := "", "red", "de", "neon"
	_, err := r.users.UpdateProfile(ctx, acctActorWith("u-worker"), ProfileUpdate{DisplayName: &bad, Color: &color, Locale: &loc, Theme: &theme})
	var ve *domain.ValidationError
	if !errors.As(err, &ve) || len(ve.Fields) != 4 {
		t.Fatalf("err = %v", err)
	}
}

func TestMeUnknownUserIsUnauthenticated(t *testing.T) {
	r := newRig(t, rigOpts{})
	if _, err := r.users.Me(ctx, acctActorWith("ghost")); !isErr(err, domain.ErrUnauthenticated) {
		t.Fatal(err)
	}
}

func TestAvatarLifecycle(t *testing.T) {
	r := newRig(t, rigOpts{})
	a := acctActorWith("u-worker")
	p, err := r.users.SetAvatar(ctx, a, []byte("png-bytes"))
	if err != nil {
		t.Fatal(err)
	}
	if p.AvatarSHA == "" {
		t.Fatal("avatar sha missing")
	}
	av, err := r.users.Avatar(ctx, "u-worker")
	if err != nil || av.MIME != "image/jpeg" || !bytes.HasPrefix(av.Data, []byte("jpeg:")) || av.SHA256 != p.AvatarSHA {
		t.Fatalf("avatar = %+v err=%v", av, err)
	}
	p, err = r.users.DeleteAvatar(ctx, a)
	if err != nil || p.AvatarSHA != "" {
		t.Fatalf("p=%+v err=%v", p, err)
	}
	if _, err := r.users.Avatar(ctx, "u-worker"); !isErr(err, domain.ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}

func TestAvatarRejections(t *testing.T) {
	r := newRig(t, rigOpts{})
	a := acctActorWith("u-worker")
	if _, err := r.users.SetAvatar(ctx, a, nil); !isErr(err, domain.ErrValidation) {
		t.Errorf("empty: %v", err)
	}
	if _, err := r.users.SetAvatar(ctx, a, make([]byte, MaxAvatarUpload+1)); !isErr(err, domain.ErrTooLarge) {
		t.Errorf("large: %v", err)
	}
	r.users.Images = acctFakeImages{err: domain.ErrImageInvalid}
	if _, err := r.users.SetAvatar(ctx, a, []byte("x")); !isErr(err, domain.ErrImageInvalid) {
		t.Errorf("invalid: %v", err)
	}
	r.users.Images = acctFakeImages{err: domain.ErrUnsupportedMedia}
	if _, err := r.users.SetAvatar(ctx, a, []byte("x")); !isErr(err, domain.ErrUnsupportedMedia) {
		t.Errorf("unsupported: %v", err)
	}
}

func TestListUsersNeedsPermission(t *testing.T) {
	r := newRig(t, rigOpts{})
	if _, err := r.users.List(ctx, acctActorWith("x")); !isErr(err, domain.ErrForbidden) {
		t.Fatal(err)
	}
	list, err := r.users.List(ctx, acctActorWith("x", domain.PermUserView))
	if err != nil || len(list) != 2 || list[0].User.Login != "admin" {
		t.Fatalf("list = %+v err=%v", list, err)
	}
}

func TestCreateUserDefaultsToWorker(t *testing.T) {
	r := newRig(t, rigOpts{})
	mgr := acctActorWith("u-admin", domain.PermUserManage)
	c, err := r.users.CreateUser(ctx, mgr, CreateUserInput{Login: " New.User ", DisplayName: "New User"})
	if err != nil {
		t.Fatal(err)
	}
	if c.TempPassword == "" || len(c.Profile.User.Roles) != 1 || c.Profile.User.Roles[0].Name != domain.RoleWorker {
		t.Fatalf("created = %+v", c)
	}
	u := c.Profile.User
	if u.Login != "new.user" || !u.PasswordTemporary || !u.IsActive || !slices.Contains(domain.UserPalette[:], u.Color) {
		t.Fatalf("user = %+v", u)
	}
	if r.db.users[u.ID].hash != "hash:"+c.TempPassword {
		t.Fatal("only the hash of the temporary password may be stored")
	}
	if got := r.audit.actions(); len(got) != 1 || got[0] != "user.create" {
		t.Fatalf("audit = %v", got)
	}
	// The new user can log in with the temporary password.
	r.login(t, "new.user", c.TempPassword)
}

func TestCreateUserRoleSelection(t *testing.T) {
	r := newRig(t, rigOpts{})
	ids := []string{"role-admin"}
	if _, err := r.users.CreateUser(ctx, acctActorWith("m", domain.PermUserManage), CreateUserInput{Login: "abc", DisplayName: "A", RoleIDs: ids}); !isErr(err, domain.ErrForbidden) {
		t.Fatalf("roleIds without role.manage: %v", err)
	}
	full := acctActorWith("m", domain.PermUserManage, domain.PermRoleManage)
	c, err := r.users.CreateUser(ctx, full, CreateUserInput{Login: "abc", DisplayName: "A", RoleIDs: []string{"role-admin", "role-admin"}})
	if err != nil || len(c.Profile.User.Roles) != 1 || !c.Profile.User.IsAdmin() {
		t.Fatalf("c=%+v err=%v", c, err)
	}
	for name, roleIDs := range map[string][]string{"empty": {}, "unknown": {"nope"}} {
		if _, err := r.users.CreateUser(ctx, full, CreateUserInput{Login: "x" + name, DisplayName: "A", RoleIDs: roleIDs}); !isErr(err, domain.ErrValidation) {
			t.Errorf("%s roleIds: %v", name, err)
		}
	}
}

func TestCreateUserValidation(t *testing.T) {
	r := newRig(t, rigOpts{})
	mgr := acctActorWith("m", domain.PermUserManage)
	if _, err := r.users.CreateUser(ctx, acctActorWith("m"), CreateUserInput{Login: "abc", DisplayName: "A"}); !isErr(err, domain.ErrForbidden) {
		t.Errorf("forbidden: %v", err)
	}
	_, err := r.users.CreateUser(ctx, mgr, CreateUserInput{Login: "A B", DisplayName: " ", Color: "zzz"})
	var ve *domain.ValidationError
	if !errors.As(err, &ve) || len(ve.Fields) != 3 {
		t.Errorf("fields: %v", err)
	}
	if _, err := r.users.CreateUser(ctx, mgr, CreateUserInput{Login: "admin", DisplayName: "dup"}); !isErr(err, domain.ErrValidation) {
		t.Errorf("duplicate login: %v", err)
	}
}

func TestCreateUserAuditFailureAborts(t *testing.T) {
	r := newRig(t, rigOpts{})
	r.audit.err = errBoom
	_, err := r.users.CreateUser(ctx, acctActorWith("m", domain.PermUserManage), CreateUserInput{Login: "abc", DisplayName: "A"})
	if !errors.Is(err, errBoom) {
		t.Fatalf("err = %v", err)
	}
}

func TestDeactivateUser(t *testing.T) {
	r := newRig(t, rigOpts{})
	mgr := acctActorWith("u-admin", domain.PermUserManage)
	off := false
	p, err := r.users.UpdateUser(ctx, mgr, "u-worker", UserUpdate{IsActive: &off})
	if err != nil || p.User.IsActive {
		t.Fatalf("p=%+v err=%v", p, err)
	}
	if r.store.cutoffs["u-worker"].IsZero() {
		t.Fatal("cutoff not written")
	}
	if len(r.revoked) != 1 || r.revoked[0] != "u-worker" {
		t.Fatalf("revoked hook = %v", r.revoked)
	}
	if got := r.audit.actions(); len(got) != 1 || got[0] != "user.deactivate" {
		t.Fatalf("audit = %v", got)
	}
	if _, err := r.auth.Login(ctx, LoginInput{Login: "worker1", Password: "worker-pass"}); !isErr(err, domain.ErrBadCredentials) {
		t.Fatalf("login after deactivation: %v", err)
	}
	// Reactivation.
	on := true
	p, err = r.users.UpdateUser(ctx, mgr, "u-worker", UserUpdate{IsActive: &on})
	if err != nil || !p.User.IsActive {
		t.Fatalf("reactivate: %+v %v", p, err)
	}
}

func TestDeactivateGuards(t *testing.T) {
	r := newRig(t, rigOpts{})
	mgr := acctActorWith("u-admin", domain.PermUserManage)
	off := false
	if _, err := r.users.UpdateUser(ctx, mgr, "u-admin", UserUpdate{IsActive: &off}); !isErr(err, domain.ErrValidation) {
		t.Errorf("self: %v", err)
	}
	// A second admin may be deactivated by the first, the last one may not.
	r.db.addUser("u-admin2", "admin2", "pw-pw-pw-pw", "role-admin")
	if _, err := r.users.UpdateUser(ctx, mgr, "u-admin2", UserUpdate{IsActive: &off}); err != nil {
		t.Fatalf("second admin: %v", err)
	}
	other := acctActorWith("someone-else", domain.PermUserManage)
	if _, err := r.users.UpdateUser(ctx, other, "u-admin", UserUpdate{IsActive: &off}); !isErr(err, domain.ErrLastAdmin) {
		t.Errorf("last admin: %v", err)
	}
	if _, err := r.users.UpdateUser(ctx, acctActorWith("x"), "u-worker", UserUpdate{IsActive: &off}); !isErr(err, domain.ErrForbidden) {
		t.Errorf("forbidden: %v", err)
	}
	if _, err := r.users.UpdateUser(ctx, mgr, "ghost", UserUpdate{IsActive: &off}); !isErr(err, domain.ErrNotFound) {
		t.Errorf("not found: %v", err)
	}
}

func TestDeactivateRedisDownRollsBack(t *testing.T) {
	r := newRig(t, rigOpts{})
	r.store.down = errBoom
	off := false
	_, err := r.users.UpdateUser(ctx, acctActorWith("u-admin", domain.PermUserManage), "u-worker", UserUpdate{IsActive: &off})
	if !isErr(err, domain.ErrAuthUnavailable) || err.Error() != domain.ErrAuthUnavailable.Message {
		t.Fatalf("err = %v", err)
	}
	if len(r.revoked) != 0 {
		t.Fatal("hook must not fire on failure")
	}
}

func TestUpdateUserName(t *testing.T) {
	r := newRig(t, rigOpts{})
	n := " Renamed "
	p, err := r.users.UpdateUser(ctx, acctActorWith("m", domain.PermUserManage), "u-worker", UserUpdate{DisplayName: &n})
	if err != nil || p.User.DisplayName != "Renamed" {
		t.Fatalf("p=%+v err=%v", p, err)
	}
	empty := ""
	if _, err := r.users.UpdateUser(ctx, acctActorWith("m", domain.PermUserManage), "u-worker", UserUpdate{DisplayName: &empty}); !isErr(err, domain.ErrValidation) {
		t.Fatal(err)
	}
}

func TestSetRolesBumpsEpoch(t *testing.T) {
	r := newRig(t, rigOpts{})
	full := acctActorWith("u-admin", domain.PermRoleManage)
	before := r.epoch.Load()
	p, err := r.users.SetRoles(ctx, full, "u-worker", []string{"role-admin", "role-worker"})
	if err != nil || len(p.User.Roles) != 2 {
		t.Fatalf("p=%+v err=%v", p, err)
	}
	if r.epoch.Load() != before+1 || r.db.bumps != 1 {
		t.Fatalf("epoch %d -> %d", before, r.epoch.Load())
	}
	if got := r.audit.actions(); got[len(got)-1] != "user.roles.set" {
		t.Fatalf("audit = %v", got)
	}
	e := r.audit.entries[len(r.audit.entries)-1]
	if added := e.Meta["added"].([]string); len(added) != 1 || added[0] != "role-admin" {
		t.Fatalf("meta = %v", e.Meta)
	}
}

func TestSetRolesGuards(t *testing.T) {
	r := newRig(t, rigOpts{})
	full := acctActorWith("u-admin", domain.PermRoleManage)
	if _, err := r.users.SetRoles(ctx, acctActorWith("x", domain.PermUserManage), "u-worker", []string{"role-admin"}); !isErr(err, domain.ErrForbidden) {
		t.Errorf("forbidden: %v", err)
	}
	for name, ids := range map[string][]string{"nil": nil, "empty": {}, "unknown": {"zzz"}} {
		if _, err := r.users.SetRoles(ctx, full, "u-worker", ids); !isErr(err, domain.ErrValidation) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// Removing admin from the last active administrator.
	if _, err := r.users.SetRoles(ctx, full, "u-admin", []string{"role-worker"}); !isErr(err, domain.ErrLastAdmin) {
		t.Errorf("last admin: %v", err)
	}
	r.db.addUser("u-admin2", "admin2", "pw-pw-pw-pw", "role-admin")
	if _, err := r.users.SetRoles(ctx, full, "u-admin", []string{"role-worker"}); err != nil {
		t.Errorf("with a second admin: %v", err)
	}
	if _, err := r.users.SetRoles(ctx, full, "ghost", []string{"role-worker"}); !isErr(err, domain.ErrNotFound) {
		t.Errorf("not found: %v", err)
	}
}

func TestResetPassword(t *testing.T) {
	r := newRig(t, rigOpts{})
	s := r.login(t, "worker1", "worker-pass")
	pw, err := r.users.ResetPassword(ctx, acctActorWith("u-admin", domain.PermUserManage), "u-worker")
	if err != nil || pw == "" {
		t.Fatalf("pw=%q err=%v", pw, err)
	}
	u := r.db.users["u-worker"]
	if u.hash != "hash:"+pw || !u.temporary {
		t.Fatal("hash/temporary not stored")
	}
	if r.store.cutoffs["u-worker"].IsZero() || len(r.revoked) != 1 {
		t.Fatal("tokens not revoked")
	}
	if _, err := r.auth.Authenticate(ctx, s.Pair.AccessToken); !isErr(err, domain.ErrUnauthenticated) {
		t.Fatalf("old access: %v", err)
	}
	if _, err := r.auth.Login(ctx, LoginInput{Login: "worker1", Password: "worker-pass"}); !isErr(err, domain.ErrBadCredentials) {
		t.Fatalf("old password: %v", err)
	}
	if got := r.audit.actions(); got[len(got)-1] != "password.reset" && got[len(got)-2] != "password.reset" {
		t.Fatalf("audit = %v", got)
	}
	if _, err := r.users.ResetPassword(ctx, acctActorWith("x"), "u-worker"); !isErr(err, domain.ErrForbidden) {
		t.Errorf("forbidden: %v", err)
	}
	if _, err := r.users.ResetPassword(ctx, acctActorWith("m", domain.PermUserManage), "ghost"); !isErr(err, domain.ErrNotFound) {
		t.Errorf("not found: %v", err)
	}
}

func TestEnsureAdmin(t *testing.T) {
	r := newRig(t, rigOpts{})
	created, err := r.users.EnsureAdmin(ctx, "Boss", "boss-password")
	if err != nil || !created {
		t.Fatalf("created=%v err=%v", created, err)
	}
	s := r.login(t, "boss", "boss-password")
	if a := r.actor(t, s); !a.Can(domain.PermRoleManage) || s.User.User.PasswordTemporary {
		t.Fatalf("actor=%+v", a)
	}
	// Reset an existing, deactivated, non-admin account.
	r.db.users["u-worker"].active = false
	created, err = r.users.EnsureAdmin(ctx, "worker1", "another-pass")
	if err != nil || created {
		t.Fatalf("created=%v err=%v", created, err)
	}
	u := r.db.users["u-worker"]
	if !u.active || u.hash != "hash:another-pass" || len(r.db.assign["u-worker"]) != 2 {
		t.Fatalf("user = %+v roles=%v", u, r.db.assign["u-worker"])
	}
	if r.db.bumps != 1 || r.store.cutoffs["u-worker"].IsZero() {
		t.Fatal("epoch/cutoff expected for a promoted account")
	}
	// Invalid input.
	if _, err := r.users.EnsureAdmin(ctx, "x", "short"); !isErr(err, domain.ErrValidation) {
		t.Fatal(err)
	}
	// No token store (CLI without Redis).
	r.users.Tokens = nil
	if _, err := r.users.EnsureAdmin(ctx, "boss", "boss-password-2"); err != nil {
		t.Fatal(err)
	}
}
