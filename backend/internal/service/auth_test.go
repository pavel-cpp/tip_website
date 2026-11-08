package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

const (
	accessTTL  = 15 * time.Minute
	refreshTTL = 720 * time.Hour
)

type rig struct {
	clock  *acctFakeClock
	db     *acctFakeDB
	store  *fakeTokenStore
	codec  *fakeCodec
	audit  *acctFakeAudit
	epoch  *Epoch
	auth   *Auth
	users  *Users
	roles  *Roles
	limit  *MemoryLoginLimiter
	hasher *fakeHasher

	storeErrs []string
	revoked   []string
}

type rigOpts struct {
	failOpen bool
	force    bool
	rehash   bool
}

func newRig(t *testing.T, o rigOpts) *rig {
	t.Helper()
	r := &rig{clock: newClock(), db: newDB(), codec: newCodec(), audit: &acctFakeAudit{}}
	r.store = newTokenStore(r.clock)
	r.db.addUser("u-admin", "admin", "admin-pass", "role-admin")
	r.db.addUser("u-worker", "worker1", "worker-pass", "role-worker")
	r.db.roles["role-worker"].Permissions = []domain.Permission{domain.PermProjectView, domain.PermParticipantView}
	ep, err := NewEpoch(context.Background(), r.db)
	if err != nil {
		t.Fatal(err)
	}
	r.epoch = ep
	r.limit = NewMemoryLoginLimiter(r.clock)
	r.hasher = &fakeHasher{rehash: o.rehash}
	ids := &acctSeqIDs{}
	r.auth = NewAuth(AuthDeps{
		Config:  AuthConfig{AccessTTL: accessTTL, RefreshTTL: refreshTTL, FailOpen: o.failOpen, ForcePasswordChange: o.force},
		Users:   r.db,
		Tokens:  r.store,
		Codec:   r.codec,
		Hasher:  r.hasher,
		Limiter: r.limit,
		Audit:   r.audit,
		Epoch:   r.epoch,
		Clock:   r.clock,
		IDs:     ids,
		OnTokenStoreError: func(op string, err error) {
			r.storeErrs = append(r.storeErrs, op)
		},
		Sleep: func(d time.Duration) { r.clock.Advance(d) },
	})
	r.users = NewUsers(UsersDeps{
		Users: r.db, Avatars: r.db, Roles: r.db.roleStore(), Authz: r.db, Epoch: r.epoch, Tx: acctFakeTx{},
		Tokens: r.store, Hasher: r.hasher, Passwords: &fixedPasswords{}, Images: acctFakeImages{}, Audit: r.audit,
		Clock: r.clock, IDs: ids, RefreshTTL: refreshTTL,
		OnUserRevoked:     func(id string) { r.revoked = append(r.revoked, id) },
		OnTokenStoreError: func(op string, err error) { r.storeErrs = append(r.storeErrs, op) },
	})
	r.roles = NewRoles(RolesDeps{Roles: r.db.roleStore(), Authz: r.db, Epoch: r.epoch, Tx: acctFakeTx{}, Audit: r.audit, IDs: ids})
	return r
}

func (r *rig) login(t *testing.T, login, pw string) Session {
	t.Helper()
	s, err := r.auth.Login(context.Background(), LoginInput{Login: login, Password: pw, IP: "1.2.3.4"})
	if err != nil {
		t.Fatalf("login %s: %v", login, err)
	}
	return s
}

func (r *rig) actor(t *testing.T, s Session) domain.Actor {
	t.Helper()
	a, err := r.auth.Authenticate(context.Background(), s.Pair.AccessToken)
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	return a
}

func isErr(err error, target *domain.Error) bool { return errors.Is(err, target) }

func TestLoginSuccess(t *testing.T) {
	r := newRig(t, rigOpts{})
	s := r.login(t, "  ADMIN ", "admin-pass")
	if s.ExpiresIn != 900 || s.Pair.AccessToken == "" || s.Pair.RefreshToken == "" {
		t.Fatalf("session = %+v", s)
	}
	if s.User.User.LastLoginAt == nil || r.db.users["u-admin"].last == nil {
		t.Fatal("last_login_at not recorded")
	}
	cl := r.codec.access[s.Pair.AccessToken]
	if cl.Subject != "u-admin" || cl.Roles[0] != "admin" || len(cl.Perms) != len(domain.AllPermissions()) || cl.PermEpoch != 1 {
		t.Fatalf("claims = %+v", cl)
	}
	rc := r.codec.refresh[s.Pair.RefreshToken]
	if rc.Family != cl.Family || rc.TokenID == cl.TokenID {
		t.Fatalf("refresh claims = %+v", rc)
	}
	if got := r.audit.actions(); len(got) != 1 || got[0] != "login" {
		t.Fatalf("audit = %v", got)
	}
}

func TestLoginRejections(t *testing.T) {
	r := newRig(t, rigOpts{})
	ctx := context.Background()
	for name, in := range map[string]LoginInput{
		"wrong password": {Login: "admin", Password: "nope"},
		"unknown user":   {Login: "ghost", Password: "whatever"},
	} {
		if _, err := r.auth.Login(ctx, in); !isErr(err, domain.ErrBadCredentials) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	r.db.users["u-worker"].active = false
	if _, err := r.auth.Login(ctx, LoginInput{Login: "worker1", Password: "worker-pass"}); !isErr(err, domain.ErrBadCredentials) {
		t.Errorf("inactive: err = %v", err)
	}
	if _, err := r.auth.Login(ctx, LoginInput{Login: "", Password: ""}); !isErr(err, domain.ErrValidation) {
		t.Errorf("empty: err = %v", err)
	}
}

func TestLoginRateLimit(t *testing.T) {
	r := newRig(t, rigOpts{})
	ctx := context.Background()
	for range 5 {
		_, _ = r.auth.Login(ctx, LoginInput{Login: "admin", Password: "bad", IP: "9.9.9.9"})
	}
	_, err := r.auth.Login(ctx, LoginInput{Login: "admin", Password: "admin-pass", IP: "9.9.9.9"})
	if !isErr(err, domain.ErrRateLimited) {
		t.Fatalf("err = %v", err)
	}
	var de *domain.Error
	if !errors.As(err, &de) || de.Details["retryAfter"].(time.Duration) <= 0 {
		t.Fatalf("missing retry-after: %v", err)
	}
	// A different IP is unaffected, and the window expires.
	if _, err := r.auth.Login(ctx, LoginInput{Login: "admin", Password: "admin-pass", IP: "8.8.8.8"}); err != nil {
		t.Fatalf("other ip: %v", err)
	}
	r.clock.Advance(16 * time.Minute)
	if _, err := r.auth.Login(ctx, LoginInput{Login: "admin", Password: "admin-pass", IP: "9.9.9.9"}); err != nil {
		t.Fatalf("after window: %v", err)
	}
}

func TestLoginRedisDown(t *testing.T) {
	r := newRig(t, rigOpts{})
	r.store.down = errBoom
	_, err := r.auth.Login(context.Background(), LoginInput{Login: "admin", Password: "admin-pass"})
	if !isErr(err, domain.ErrAuthUnavailable) || err.Error() != domain.ErrAuthUnavailable.Message {
		t.Fatalf("err = %v", err)
	}
	if len(r.storeErrs) != 1 {
		t.Fatalf("hook calls = %v", r.storeErrs)
	}
}

func TestLoginRehashesStoredPassword(t *testing.T) {
	r := newRig(t, rigOpts{rehash: true})
	r.login(t, "admin", "admin-pass")
	if r.db.users["u-admin"].hash != "hash:admin-pass" {
		t.Fatal("hash lost")
	}
}

func TestAuthenticateHappyAndErrors(t *testing.T) {
	r := newRig(t, rigOpts{})
	s := r.login(t, "worker1", "worker-pass")
	a := r.actor(t, s)
	if a.UserID != "u-worker" || !a.Can(domain.PermProjectView) || a.Can(domain.PermRoleManage) {
		t.Fatalf("actor = %+v", a)
	}
	ctx := context.Background()
	if _, err := r.auth.Authenticate(ctx, "garbage"); !isErr(err, domain.ErrUnauthenticated) {
		t.Fatalf("garbage: %v", err)
	}
	r.clock.Advance(accessTTL + time.Second)
	if _, err := r.auth.Authenticate(ctx, s.Pair.AccessToken); !isErr(err, domain.ErrTokenExpired) {
		t.Fatalf("expired: %v", err)
	}
}

func TestAuthenticateStaleEpoch(t *testing.T) {
	r := newRig(t, rigOpts{})
	s := r.login(t, "worker1", "worker-pass")
	r.epoch.Set(5)
	if _, err := r.auth.Authenticate(context.Background(), s.Pair.AccessToken); !isErr(err, domain.ErrTokenStale) {
		t.Fatalf("err = %v", err)
	}
	// Refresh yields a token carrying the new epoch.
	rs, err := r.auth.Refresh(context.Background(), s.Pair.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	if got := r.codec.access[rs.Pair.AccessToken].PermEpoch; got != 5 {
		t.Fatalf("pe = %d", got)
	}
	r.actor(t, rs)
}

func TestAuthenticateRevocations(t *testing.T) {
	ctx := context.Background()
	t.Run("blacklisted jti", func(t *testing.T) {
		r := newRig(t, rigOpts{})
		s := r.login(t, "worker1", "worker-pass")
		r.store.access[r.codec.access[s.Pair.AccessToken].TokenID] = true
		if _, err := r.auth.Authenticate(ctx, s.Pair.AccessToken); !isErr(err, domain.ErrUnauthenticated) {
			t.Fatal(err)
		}
	})
	t.Run("closed family", func(t *testing.T) {
		r := newRig(t, rigOpts{})
		s := r.login(t, "worker1", "worker-pass")
		r.store.families[s.Pair.Family] = true
		if _, err := r.auth.Authenticate(ctx, s.Pair.AccessToken); !isErr(err, domain.ErrUnauthenticated) {
			t.Fatal(err)
		}
	})
	t.Run("user cutoff", func(t *testing.T) {
		r := newRig(t, rigOpts{})
		s := r.login(t, "worker1", "worker-pass")
		r.store.cutoffs["u-worker"] = r.clock.Now()
		if _, err := r.auth.Authenticate(ctx, s.Pair.AccessToken); !isErr(err, domain.ErrUnauthenticated) {
			t.Fatal(err)
		}
	})
}

func TestAuthenticateRedisFailModes(t *testing.T) {
	ctx := context.Background()
	t.Run("open skips the blacklist and reports", func(t *testing.T) {
		r := newRig(t, rigOpts{failOpen: true})
		s := r.login(t, "worker1", "worker-pass")
		r.store.down = errBoom
		a, err := r.auth.Authenticate(ctx, s.Pair.AccessToken)
		if err != nil || a.UserID != "u-worker" {
			t.Fatalf("a=%+v err=%v", a, err)
		}
		if len(r.storeErrs) != 1 || r.storeErrs[0] != "authenticate" {
			t.Fatalf("hook = %v", r.storeErrs)
		}
	})
	t.Run("closed answers AUTH_UNAVAILABLE", func(t *testing.T) {
		r := newRig(t, rigOpts{})
		s := r.login(t, "worker1", "worker-pass")
		r.store.down = errBoom
		if _, err := r.auth.Authenticate(ctx, s.Pair.AccessToken); !isErr(err, domain.ErrAuthUnavailable) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestRefreshRotation(t *testing.T) {
	r := newRig(t, rigOpts{})
	ctx := context.Background()
	s := r.login(t, "worker1", "worker-pass")
	r.clock.Advance(time.Minute)
	n, err := r.auth.Refresh(ctx, s.Pair.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	if n.Pair.RefreshToken == s.Pair.RefreshToken || n.Pair.Family != s.Pair.Family {
		t.Fatal("rotation must change the token and keep the family")
	}
	old := r.codec.refresh[s.Pair.RefreshToken]
	if _, burned := r.store.burned[old.TokenID]; !burned {
		t.Fatal("old refresh not burnt")
	}
	// The new refresh keeps working.
	if _, err := r.auth.Refresh(ctx, n.Pair.RefreshToken); err != nil {
		t.Fatalf("second rotation: %v", err)
	}
}

func TestRefreshReplayWithinWindowIsIdempotent(t *testing.T) {
	r := newRig(t, rigOpts{})
	ctx := context.Background()
	s := r.login(t, "worker1", "worker-pass")
	n1, err := r.auth.Refresh(ctx, s.Pair.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	r.clock.Advance(3 * time.Second)
	n2, err := r.auth.Refresh(ctx, s.Pair.RefreshToken)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if n2.Pair.RefreshToken != n1.Pair.RefreshToken {
		t.Fatal("replay must return the same new refresh token")
	}
	r.actor(t, n2)
	if r.store.families[s.Pair.Family] {
		t.Fatal("replay inside the window must not close the family")
	}
}

func TestRefreshReplayWaitsForSlowWinner(t *testing.T) {
	r := newRig(t, rigOpts{})
	ctx := context.Background()
	s := r.login(t, "worker1", "worker-pass")
	if _, err := r.auth.Refresh(ctx, s.Pair.RefreshToken); err != nil {
		t.Fatal(err)
	}
	r.store.replayMisses = 3
	if _, err := r.auth.Refresh(ctx, s.Pair.RefreshToken); err != nil {
		t.Fatalf("replay after misses: %v", err)
	}
}

func TestRefreshReplayWithoutEntryFails(t *testing.T) {
	r := newRig(t, rigOpts{})
	ctx := context.Background()
	s := r.login(t, "worker1", "worker-pass")
	claims := r.codec.refresh[s.Pair.RefreshToken]
	r.store.burned[claims.TokenID] = r.clock.Now() // burnt by a winner that never published a pair
	if _, err := r.auth.Refresh(ctx, s.Pair.RefreshToken); !isErr(err, domain.ErrRefreshInvalid) {
		t.Fatalf("err = %v", err)
	}
}

func TestRefreshReuseAfterWindowClosesFamily(t *testing.T) {
	r := newRig(t, rigOpts{})
	ctx := context.Background()
	s := r.login(t, "worker1", "worker-pass")
	n, err := r.auth.Refresh(ctx, s.Pair.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	r.clock.Advance(11 * time.Second)
	if _, err := r.auth.Refresh(ctx, s.Pair.RefreshToken); !isErr(err, domain.ErrRefreshInvalid) {
		t.Fatalf("reuse: %v", err)
	}
	if !r.store.families[s.Pair.Family] {
		t.Fatal("family must be closed on reuse")
	}
	// The thief's victim chain is dead too.
	if _, err := r.auth.Refresh(ctx, n.Pair.RefreshToken); !isErr(err, domain.ErrRefreshInvalid) {
		t.Fatalf("new refresh after reuse: %v", err)
	}
	if _, err := r.auth.Authenticate(ctx, n.Pair.AccessToken); !isErr(err, domain.ErrUnauthenticated) {
		t.Fatalf("access after reuse: %v", err)
	}
}

func TestRefreshLostBurnRace(t *testing.T) {
	r := newRig(t, rigOpts{})
	ctx := context.Background()
	s := r.login(t, "worker1", "worker-pass")
	n1, err := r.auth.Refresh(ctx, s.Pair.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate Revocation() having run before the winner burned: BurnRefresh then loses the race.
	claims := r.codec.refresh[s.Pair.RefreshToken]
	st := &raceStore{fakeTokenStore: r.store, hide: claims.TokenID}
	r.auth.Tokens = st
	n2, err := r.auth.Refresh(ctx, s.Pair.RefreshToken)
	if err != nil || n2.Pair.RefreshToken != n1.Pair.RefreshToken {
		t.Fatalf("n2=%+v err=%v", n2, err)
	}
}

// raceStore hides the burn mark from Revocation once, as if the lookup preceded the winner.
type raceStore struct {
	*fakeTokenStore
	hide string
}

func (s *raceStore) Revocation(ctx context.Context, q domain.RevocationQuery) (domain.RevocationState, error) {
	st, err := s.fakeTokenStore.Revocation(ctx, q)
	if q.RefreshJTI == s.hide {
		st.RefreshBurnedAt = time.Time{}
	}
	return st, err
}

func TestRefreshRejections(t *testing.T) {
	ctx := context.Background()
	t.Run("garbage", func(t *testing.T) {
		r := newRig(t, rigOpts{})
		if _, err := r.auth.Refresh(ctx, "nope"); !isErr(err, domain.ErrRefreshInvalid) {
			t.Fatal(err)
		}
	})
	t.Run("deactivated user", func(t *testing.T) {
		r := newRig(t, rigOpts{})
		s := r.login(t, "worker1", "worker-pass")
		r.db.users["u-worker"].active = false
		if _, err := r.auth.Refresh(ctx, s.Pair.RefreshToken); !isErr(err, domain.ErrRefreshInvalid) {
			t.Fatal(err)
		}
	})
	t.Run("deleted user", func(t *testing.T) {
		r := newRig(t, rigOpts{})
		s := r.login(t, "worker1", "worker-pass")
		delete(r.db.users, "u-worker")
		if _, err := r.auth.Refresh(ctx, s.Pair.RefreshToken); !isErr(err, domain.ErrRefreshInvalid) {
			t.Fatal(err)
		}
	})
	t.Run("closed family", func(t *testing.T) {
		r := newRig(t, rigOpts{})
		s := r.login(t, "worker1", "worker-pass")
		r.store.families[s.Pair.Family] = true
		if _, err := r.auth.Refresh(ctx, s.Pair.RefreshToken); !isErr(err, domain.ErrRefreshInvalid) {
			t.Fatal(err)
		}
	})
	t.Run("user cutoff", func(t *testing.T) {
		r := newRig(t, rigOpts{})
		s := r.login(t, "worker1", "worker-pass")
		r.store.cutoffs["u-worker"] = r.clock.Now().Add(time.Second)
		if _, err := r.auth.Refresh(ctx, s.Pair.RefreshToken); !isErr(err, domain.ErrRefreshInvalid) {
			t.Fatal(err)
		}
	})
	t.Run("redis down", func(t *testing.T) {
		r := newRig(t, rigOpts{failOpen: true})
		s := r.login(t, "worker1", "worker-pass")
		r.store.down = errBoom
		if _, err := r.auth.Refresh(ctx, s.Pair.RefreshToken); !isErr(err, domain.ErrAuthUnavailable) {
			t.Fatalf("refresh must be 503 even in open mode: %v", err)
		}
	})
	t.Run("picks up new roles", func(t *testing.T) {
		r := newRig(t, rigOpts{})
		s := r.login(t, "worker1", "worker-pass")
		r.db.roles["role-worker"].Permissions = append(r.db.roles["role-worker"].Permissions, domain.PermParticipantEdit)
		n, err := r.auth.Refresh(ctx, s.Pair.RefreshToken)
		if err != nil {
			t.Fatal(err)
		}
		if !r.actor(t, n).Can(domain.PermParticipantEdit) {
			t.Fatal("refreshed token must carry fresh permissions")
		}
	})
}

func TestLogout(t *testing.T) {
	r := newRig(t, rigOpts{})
	ctx := context.Background()
	s := r.login(t, "worker1", "worker-pass")
	a := r.actor(t, s)
	if err := r.auth.Logout(ctx, a); err != nil {
		t.Fatal(err)
	}
	if _, err := r.auth.Authenticate(ctx, s.Pair.AccessToken); !isErr(err, domain.ErrUnauthenticated) {
		t.Fatalf("access after logout: %v", err)
	}
	if _, err := r.auth.Refresh(ctx, s.Pair.RefreshToken); !isErr(err, domain.ErrRefreshInvalid) {
		t.Fatalf("refresh after logout: %v", err)
	}
	r.store.down = errBoom
	if err := r.auth.Logout(ctx, a); !isErr(err, domain.ErrAuthUnavailable) {
		t.Fatalf("logout w/o redis: %v", err)
	}
}

func TestChangePassword(t *testing.T) {
	r := newRig(t, rigOpts{})
	ctx := context.Background()
	r.db.users["u-worker"].temporary = true
	s := r.login(t, "worker1", "worker-pass")
	a := r.actor(t, s)

	if _, err := r.auth.ChangePassword(ctx, a, ChangePasswordInput{Current: "worker-pass", New: "short"}); !isErr(err, domain.ErrValidation) {
		t.Fatalf("short: %v", err)
	}
	_, err := r.auth.ChangePassword(ctx, a, ChangePasswordInput{Current: "wrong", New: "new-password-1"})
	var ve *domain.ValidationError
	if !errors.As(err, &ve) || ve.Fields[0].Field != "current" {
		t.Fatalf("wrong current: %v", err)
	}

	r.clock.Advance(time.Minute)
	n, err := r.auth.ChangePassword(ctx, a, ChangePasswordInput{Current: "worker-pass", New: "new-password-1"})
	if err != nil {
		t.Fatal(err)
	}
	if r.db.users["u-worker"].temporary || r.db.users["u-worker"].hash != "hash:new-password-1" {
		t.Fatal("password not stored / temporary flag not cleared")
	}
	cutoff := r.store.cutoffs["u-worker"]
	if cutoff.IsZero() {
		t.Fatal("cutoff not written")
	}
	if iat := r.codec.access[n.Pair.AccessToken].IssuedAt; !iat.After(cutoff) {
		t.Fatalf("new iat %v must be strictly after cutoff %v", iat, cutoff)
	}
	if iat := r.codec.refresh[n.Pair.RefreshToken].IssuedAt; !iat.After(cutoff) {
		t.Fatal("new refresh iat must be after the cutoff")
	}
	// Old tokens are dead, the new pair works.
	if _, err := r.auth.Authenticate(ctx, s.Pair.AccessToken); !isErr(err, domain.ErrUnauthenticated) {
		t.Fatalf("old access: %v", err)
	}
	if _, err := r.auth.Refresh(ctx, s.Pair.RefreshToken); !isErr(err, domain.ErrRefreshInvalid) {
		t.Fatalf("old refresh: %v", err)
	}
	r.actor(t, n)
	if _, err := r.auth.Refresh(ctx, n.Pair.RefreshToken); err != nil {
		t.Fatalf("new refresh: %v", err)
	}
}

func TestChangePasswordRedisDownLeavesPassword(t *testing.T) {
	r := newRig(t, rigOpts{})
	s := r.login(t, "worker1", "worker-pass")
	a := r.actor(t, s)
	r.store.down = errBoom
	_, err := r.auth.ChangePassword(context.Background(), a, ChangePasswordInput{Current: "worker-pass", New: "new-password-1"})
	if !isErr(err, domain.ErrAuthUnavailable) {
		t.Fatalf("err = %v", err)
	}
	if r.db.users["u-worker"].hash != "hash:worker-pass" {
		t.Fatal("password must not change when the cutoff cannot be written")
	}
}

func TestChangePasswordThrottled(t *testing.T) {
	r := newRig(t, rigOpts{})
	ctx := context.Background()
	s := r.login(t, "worker1", "worker-pass")
	a := r.actor(t, s)
	for range 5 {
		_, _ = r.auth.ChangePassword(ctx, a, ChangePasswordInput{Current: "bad", New: "new-password-1", IP: "7.7.7.7"})
	}
	_, err := r.auth.ChangePassword(ctx, a, ChangePasswordInput{Current: "worker-pass", New: "new-password-1", IP: "7.7.7.7"})
	if !isErr(err, domain.ErrRateLimited) {
		t.Fatalf("err = %v", err)
	}
}

func TestForcePasswordChange(t *testing.T) {
	r := newRig(t, rigOpts{force: true})
	ctx := context.Background()
	r.db.users["u-worker"].temporary = true
	s := r.login(t, "worker1", "worker-pass")
	cl := r.codec.access[s.Pair.AccessToken]
	if len(cl.Perms) != 0 || len(cl.Roles) != 1 || cl.Roles[0] != RolePasswordChange {
		t.Fatalf("restricted token expected, got %+v", cl)
	}
	a, err := r.auth.Authenticate(ctx, s.Pair.AccessToken)
	if !isErr(err, domain.ErrPasswordChangeReq) || a.UserID != "u-worker" || len(a.Perms) != 0 || len(a.Roles) != 0 {
		t.Fatalf("a=%+v err=%v", a, err)
	}
	// Changing the password lifts the restriction.
	n, err := r.auth.ChangePassword(ctx, a, ChangePasswordInput{Current: "worker-pass", New: "new-password-1"})
	if err != nil {
		t.Fatal(err)
	}
	a2, err := r.auth.Authenticate(ctx, n.Pair.AccessToken)
	if err != nil || !a2.Can(domain.PermProjectView) {
		t.Fatalf("a2=%+v err=%v", a2, err)
	}
	// Refresh while still temporary keeps the restriction; the marker is dropped when the flag is off.
	r.clock.Advance(time.Second)
	r.db.users["u-worker"].temporary = true
	n2, err := r.auth.Refresh(ctx, n.Pair.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.auth.Authenticate(ctx, n2.Pair.AccessToken); !isErr(err, domain.ErrPasswordChangeReq) {
		t.Fatalf("err = %v", err)
	}
	r.auth.Config.ForcePasswordChange = false
	if _, err := r.auth.Authenticate(ctx, n2.Pair.AccessToken); !isErr(err, domain.ErrTokenStale) {
		t.Fatalf("marker with force off must be stale: %v", err)
	}
}

func TestTemporaryPasswordNotRestrictedWithoutForce(t *testing.T) {
	r := newRig(t, rigOpts{})
	r.db.users["u-worker"].temporary = true
	s := r.login(t, "worker1", "worker-pass")
	if !s.User.User.PasswordTemporary {
		t.Fatal("flag must be reported")
	}
	if !r.actor(t, s).Can(domain.PermProjectView) {
		t.Fatal("permissions must be intact")
	}
}

func TestEpochSubscribe(t *testing.T) {
	r := newRig(t, rigOpts{})
	var got []int64
	r.epoch.Subscribe(func(e int64) { got = append(got, e) })
	r.epoch.Set(3)
	r.epoch.Set(2) // never moves backwards
	r.epoch.Set(3)
	r.epoch.Set(4)
	if len(got) != 2 || got[0] != 3 || got[1] != 4 || r.epoch.Load() != 4 {
		t.Fatalf("got %v, epoch %d", got, r.epoch.Load())
	}
	if err := r.epoch.Reload(context.Background(), r.db); err != nil || r.epoch.Load() != 4 {
		t.Fatal("reload must not lower the epoch")
	}
}

func TestMemoryLoginLimiterIPBudget(t *testing.T) {
	c := newClock()
	l := NewMemoryLoginLimiter(c)
	for i := range 20 {
		l.Fail("1.1.1.1", "user"+string(rune('a'+i)))
	}
	if l.Check("1.1.1.1", "fresh") <= 0 {
		t.Fatal("per-IP budget must block other logins")
	}
	if l.Check("2.2.2.2", "fresh") != 0 {
		t.Fatal("other IP must be free")
	}
	l.Succeed("1.1.1.1", "usera")
	if l.Check("1.1.1.1", "fresh") <= 0 {
		t.Fatal("Succeed must not reset the IP budget")
	}
	c.Advance(loginWindow)
	if l.Check("1.1.1.1", "fresh") != 0 {
		t.Fatal("window must expire")
	}
}
