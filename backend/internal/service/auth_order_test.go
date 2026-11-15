package service

import (
	"context"
	"errors"
	"testing"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// grantWhileHashing simulates a role change committing while the password hash is being
// computed: the permissions grow in the store and the epoch moves forward.
func grantWhileHashing(r *rig) {
	r.hasher.slow = func() {
		r.hasher.slow = nil
		r.db.roles["role-worker"].Permissions = append(r.db.roles["role-worker"].Permissions, domain.PermUserManage)
		r.epoch.Set(r.epoch.Load() + 1)
	}
}

// A user read before a role change must not be stamped with the epoch that follows the change,
// or the stale permission set would pass as current for a whole access token lifetime.
func TestLoginEpochIsReadBeforeTheUser(t *testing.T) {
	r := newRig(t, rigOpts{})
	grantWhileHashing(r)
	s := r.login(t, "worker1", "worker-pass")
	if _, err := r.auth.Authenticate(context.Background(), s.Pair.AccessToken); !isErr(err, domain.ErrTokenStale) {
		t.Fatalf("token issued across a role change must be stale, got %v", err)
	}
}

func TestChangePasswordEpochIsReadBeforeTheUser(t *testing.T) {
	r := newRig(t, rigOpts{})
	s := r.login(t, "worker1", "worker-pass")
	a := r.actor(t, s)
	grantWhileHashing(r)
	n, err := r.auth.ChangePassword(context.Background(), a, ChangePasswordInput{Current: "worker-pass", New: "new-password-1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.auth.Authenticate(context.Background(), n.Pair.AccessToken); !isErr(err, domain.ErrTokenStale) {
		t.Fatalf("token issued across a role change must be stale, got %v", err)
	}
}

func TestChangePasswordRejectsTheSamePassword(t *testing.T) {
	r := newRig(t, rigOpts{force: true})
	r.db.users["u-worker"].temporary = true
	s := r.login(t, "worker1", "worker-pass")
	a, _ := r.auth.Authenticate(context.Background(), s.Pair.AccessToken)
	_, err := r.auth.ChangePassword(context.Background(), a, ChangePasswordInput{Current: "worker-pass", New: "worker-pass"})
	var ve *domain.ValidationError
	if !errors.As(err, &ve) || len(ve.Fields) != 1 || ve.Fields[0].Field != "new" {
		t.Fatalf("err = %v", err)
	}
	if !r.db.users["u-worker"].temporary || r.db.users["u-worker"].hash != "hash:worker-pass" {
		t.Fatal("nothing may change")
	}
}

func TestLogoutAndPasswordChangeKickSockets(t *testing.T) {
	r := newRig(t, rigOpts{})
	var kicked []string
	r.auth.OnUserRevoked = func(id string) { kicked = append(kicked, id) }
	s := r.login(t, "worker1", "worker-pass")
	a := r.actor(t, s)
	if _, err := r.auth.ChangePassword(context.Background(), a, ChangePasswordInput{Current: "worker-pass", New: "new-password-1"}); err != nil {
		t.Fatal(err)
	}
	if len(kicked) != 1 || kicked[0] != "u-worker" {
		t.Fatalf("after password change: %v", kicked)
	}
	if err := r.auth.Logout(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	if len(kicked) != 2 {
		t.Fatalf("after logout: %v", kicked)
	}
	r.store.down = errBoom
	_ = r.auth.Logout(context.Background(), a)
	if len(kicked) != 2 {
		t.Fatal("a failed logout must not kick")
	}
}
