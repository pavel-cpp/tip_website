package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

type acctFakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *acctFakeClock {
	return &acctFakeClock{t: time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)}
}

func (c *acctFakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *acctFakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type acctSeqIDs struct {
	mu sync.Mutex
	n  int
}

func (s *acctSeqIDs) NewID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.n++
	return fmt.Sprintf("id-%04d", s.n)
}

// acctFakeTx runs the function directly; rollback is not modelled.
type acctFakeTx struct{}

func (acctFakeTx) Do(ctx context.Context, fn func(context.Context) error) error { return fn(ctx) }

type fakeHasher struct {
	rehash   bool
	failHash error
}

func (h fakeHasher) Hash(_ context.Context, pw string) (string, error) {
	if h.failHash != nil {
		return "", h.failHash
	}
	return "hash:" + pw, nil
}

func (h fakeHasher) Verify(_ context.Context, pw, hash string) (bool, bool, error) {
	if hash == "" {
		return false, false, nil
	}
	return hash == "hash:"+pw, h.rehash, nil
}

type fixedPasswords struct{ n int }

func (p *fixedPasswords) NewPassword() (string, error) {
	p.n++
	return fmt.Sprintf("TempPass%08d", p.n), nil
}

// fakeCodec keeps issued tokens in memory so tests can inspect the claims.
type fakeCodec struct {
	mu      sync.Mutex
	n       int
	access  map[string]domain.AccessClaims
	refresh map[string]domain.RefreshClaims
}

func newCodec() *fakeCodec {
	return &fakeCodec{access: map[string]domain.AccessClaims{}, refresh: map[string]domain.RefreshClaims{}}
}

func (c *fakeCodec) IssueAccess(cl domain.AccessClaims) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n++
	tok := fmt.Sprintf("access-%d", c.n)
	c.access[tok] = cl
	return tok, nil
}

func (c *fakeCodec) IssueRefresh(cl domain.RefreshClaims) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n++
	tok := fmt.Sprintf("refresh-%d", c.n)
	c.refresh[tok] = cl
	return tok, nil
}

func (c *fakeCodec) VerifyAccess(tok string, now time.Time) (domain.AccessClaims, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cl, ok := c.access[tok]
	if !ok {
		return domain.AccessClaims{}, domain.ErrUnauthenticated
	}
	if cl.Expired(now) {
		return domain.AccessClaims{}, domain.ErrTokenExpired
	}
	return cl, nil
}

func (c *fakeCodec) VerifyRefresh(tok string, now time.Time) (domain.RefreshClaims, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cl, ok := c.refresh[tok]
	if !ok || cl.Expired(now) {
		return domain.RefreshClaims{}, domain.ErrRefreshInvalid
	}
	return cl, nil
}

// fakeTokenStore models the Redis token store, expiring entries on a fake clock.
type fakeTokenStore struct {
	clock *acctFakeClock
	mu    sync.Mutex
	down  error

	burned   map[string]time.Time
	replays  map[string]entry
	families map[string]bool
	access   map[string]bool
	cutoffs  map[string]time.Time
	// replayDelay hides replay entries for this many Replay calls (simulates an in-flight winner).
	replayMisses int
}

type entry struct {
	val     string
	expires time.Time
}

func newTokenStore(c *acctFakeClock) *fakeTokenStore {
	return &fakeTokenStore{
		clock: c, burned: map[string]time.Time{}, replays: map[string]entry{},
		families: map[string]bool{}, access: map[string]bool{}, cutoffs: map[string]time.Time{},
	}
}

func (s *fakeTokenStore) Ping(context.Context) error { return s.down }

func (s *fakeTokenStore) Revocation(_ context.Context, q domain.RevocationQuery) (domain.RevocationState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.down != nil {
		return domain.RevocationState{}, s.down
	}
	return domain.RevocationState{
		AccessRevoked:   q.AccessJTI != "" && s.access[q.AccessJTI],
		RefreshBurnedAt: s.burned[q.RefreshJTI],
		FamilyClosed:    q.Family != "" && s.families[q.Family],
		UserCutoff:      s.cutoffs[q.UserID],
	}, nil
}

func (s *fakeTokenStore) BurnRefresh(_ context.Context, jti string, at time.Time, _ time.Duration) (bool, time.Time, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.down != nil {
		return false, time.Time{}, s.down
	}
	if t, ok := s.burned[jti]; ok {
		return false, t, nil
	}
	s.burned[jti] = at
	return true, at, nil
}

func (s *fakeTokenStore) StoreReplay(_ context.Context, jti, next string, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.down != nil {
		return s.down
	}
	s.replays[jti] = entry{val: next, expires: s.clock.Now().Add(ttl)}
	return nil
}

func (s *fakeTokenStore) Replay(_ context.Context, jti string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.down != nil {
		return "", false, s.down
	}
	if s.replayMisses > 0 {
		s.replayMisses--
		return "", false, nil
	}
	e, ok := s.replays[jti]
	if !ok || !s.clock.Now().Before(e.expires) {
		return "", false, nil
	}
	return e.val, true, nil
}

func (s *fakeTokenStore) CloseFamily(_ context.Context, fam string, _ time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.down != nil {
		return s.down
	}
	s.families[fam] = true
	return nil
}

func (s *fakeTokenStore) RevokeAccess(_ context.Context, jti string, _ time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.down != nil {
		return s.down
	}
	s.access[jti] = true
	return nil
}

func (s *fakeTokenStore) SetUserCutoff(_ context.Context, uid string, cutoff time.Time, _ time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.down != nil {
		return s.down
	}
	s.cutoffs[uid] = cutoff
	return nil
}

type acctFakeAudit struct {
	mu      sync.Mutex
	entries []domain.AccountAuditEntry
	err     error
}

func (a *acctFakeAudit) Record(_ context.Context, e domain.AccountAuditEntry) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.err != nil {
		return a.err
	}
	a.entries = append(a.entries, e)
	return nil
}

func (a *acctFakeAudit) actions() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []string
	for _, e := range a.entries {
		out = append(out, e.Action)
	}
	return out
}

type acctFakeImages struct {
	err error
}

func (f acctFakeImages) ProcessAvatar(_ context.Context, raw []byte) (string, []byte, error) {
	if f.err != nil {
		return "", nil, f.err
	}
	return "image/jpeg", append([]byte("jpeg:"), raw...), nil
}

// acctFakeDB implements UserStore, AvatarStore, RoleStore and AuthzState in memory.
type acctFakeDB struct {
	mu       sync.Mutex
	users    map[string]*dbUser
	roles    map[string]*domain.Role
	assign   map[string][]string // user id -> role ids
	avatars  map[string]domain.Avatar
	epoch    int64
	catalog  []domain.PermissionInfo
	bumps    int
	failList error
}

type dbUser struct {
	domain.NewUser
	active    bool
	temporary bool
	hash      string
	last      *time.Time
	locale    domain.Locale
	theme     domain.Theme
}

func newDB() *acctFakeDB {
	db := &acctFakeDB{
		users: map[string]*dbUser{}, roles: map[string]*domain.Role{},
		assign: map[string][]string{}, avatars: map[string]domain.Avatar{}, epoch: 1,
	}
	db.roles["role-admin"] = &domain.Role{ID: "role-admin", Name: domain.RoleAdmin, IsSystem: true, Permissions: domain.AllPermissions()}
	db.roles["role-worker"] = &domain.Role{ID: "role-worker", Name: domain.RoleWorker, IsSystem: true}
	return db
}

// addUser seeds a user with the given roles.
func (db *acctFakeDB) addUser(id, login, password string, roleIDs ...string) {
	db.users[id] = &dbUser{
		NewUser: domain.NewUser{ID: id, Login: login, DisplayName: login, Color: domain.DefaultColor, PasswordHash: "hash:" + password},
		active:  true, hash: "hash:" + password, locale: domain.LocaleRU, theme: domain.ThemeDark,
	}
	db.assign[id] = roleIDs
}

func (db *acctFakeDB) record(u *dbUser) domain.UserRecord {
	rec := domain.UserRecord{
		User: domain.User{
			ID: u.ID, Login: u.Login, DisplayName: u.DisplayName, Color: u.Color, Locale: u.locale, Theme: u.theme,
			PasswordTemporary: u.temporary, IsActive: u.active, LastLoginAt: u.last,
		},
		PasswordHash: u.hash,
	}
	set := domain.PermissionSet{}
	for _, rid := range db.assign[u.ID] {
		r := db.roles[rid]
		rec.Roles = append(rec.Roles, domain.RoleRef{ID: r.ID, Name: r.Name})
		for _, p := range r.Permissions {
			set[p] = struct{}{}
		}
	}
	rec.Permissions = set.Sorted()
	if av, ok := db.avatars[u.ID]; ok {
		rec.AvatarSHA = av.SHA256
	}
	return rec
}

func (db *acctFakeDB) Create(_ context.Context, u domain.NewUser) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	for _, x := range db.users {
		if x.Login == u.Login {
			return domain.NewValidation(domain.FieldError{Field: "login", Reason: "already taken"})
		}
	}
	db.users[u.ID] = &dbUser{NewUser: u, active: true, temporary: u.PasswordTemporary, hash: u.PasswordHash, locale: domain.LocaleRU, theme: domain.ThemeDark}
	return nil
}

func (db *acctFakeDB) GetByID(_ context.Context, id string) (domain.UserRecord, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	u, ok := db.users[id]
	if !ok {
		return domain.UserRecord{}, domain.ErrNotFound
	}
	return db.record(u), nil
}

func (db *acctFakeDB) GetByLogin(_ context.Context, login string) (domain.UserRecord, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	for _, u := range db.users {
		if u.Login == login {
			return db.record(u), nil
		}
	}
	return domain.UserRecord{}, domain.ErrNotFound
}

func (db *acctFakeDB) List(context.Context) ([]domain.UserRecord, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	if db.failList != nil {
		return nil, db.failList
	}
	var out []domain.UserRecord
	for _, u := range db.users {
		out = append(out, db.record(u))
	}
	slices.SortFunc(out, func(a, b domain.UserRecord) int { return strings.Compare(a.Login, b.Login) })
	return out, nil
}

func (db *acctFakeDB) UpdateProfile(_ context.Context, id string, p domain.ProfilePatch) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	u, ok := db.users[id]
	if !ok {
		return domain.ErrNotFound
	}
	if p.DisplayName != nil {
		u.DisplayName = *p.DisplayName
	}
	if p.Color != nil {
		u.Color = *p.Color
	}
	if p.Locale != nil {
		u.locale = *p.Locale
	}
	if p.Theme != nil {
		u.theme = *p.Theme
	}
	return nil
}

func (db *acctFakeDB) SetPassword(_ context.Context, id, hash string, temporary bool) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	u, ok := db.users[id]
	if !ok {
		return domain.ErrNotFound
	}
	u.hash, u.temporary = hash, temporary
	return nil
}

func (db *acctFakeDB) SetActive(_ context.Context, id string, active bool) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	u, ok := db.users[id]
	if !ok {
		return domain.ErrNotFound
	}
	u.active = active
	return nil
}

func (db *acctFakeDB) TouchLastLogin(_ context.Context, id string, at time.Time) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	if u, ok := db.users[id]; ok {
		u.last = &at
	}
	return nil
}

func (db *acctFakeDB) SetRoles(_ context.Context, userID string, roleIDs []string) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.assign[userID] = slices.Clone(roleIDs)
	return nil
}

func (db *acctFakeDB) CountActiveAdmins(context.Context) (int, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	n := 0
	for id, u := range db.users {
		if !u.active {
			continue
		}
		for _, rid := range db.assign[id] {
			if db.roles[rid].Name == domain.RoleAdmin {
				n++
				break
			}
		}
	}
	return n, nil
}

func (db *acctFakeDB) PutAvatar(_ context.Context, id string, a domain.Avatar, _ time.Time) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.avatars[id] = a
	return nil
}

func (db *acctFakeDB) GetAvatar(_ context.Context, id string) (domain.Avatar, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	a, ok := db.avatars[id]
	if !ok {
		return domain.Avatar{}, domain.ErrNotFound
	}
	return a, nil
}

func (db *acctFakeDB) DeleteAvatar(_ context.Context, id string) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	delete(db.avatars, id)
	return nil
}

func (db *acctFakeDB) userCount(roleID string) int {
	n := 0
	for _, ids := range db.assign {
		if slices.Contains(ids, roleID) {
			n++
		}
	}
	return n
}

// RoleStore.

func (db *acctFakeDB) roleList() []domain.Role {
	var out []domain.Role
	for _, r := range db.roles {
		c := *r
		c.UserCount = db.userCount(r.ID)
		out = append(out, c)
	}
	slices.SortFunc(out, func(a, b domain.Role) int { return strings.Compare(a.Name, b.Name) })
	return out
}

type roleStoreView struct{ db *acctFakeDB }

func (db *acctFakeDB) roleStore() roleStoreView { return roleStoreView{db} }

func (v roleStoreView) List(context.Context) ([]domain.Role, error) {
	v.db.mu.Lock()
	defer v.db.mu.Unlock()
	return v.db.roleList(), nil
}

func (v roleStoreView) Get(_ context.Context, id string) (domain.Role, error) {
	v.db.mu.Lock()
	defer v.db.mu.Unlock()
	r, ok := v.db.roles[id]
	if !ok {
		return domain.Role{}, domain.ErrNotFound
	}
	c := *r
	c.UserCount = v.db.userCount(id)
	return c, nil
}

func (v roleStoreView) GetByName(_ context.Context, name string) (domain.Role, error) {
	v.db.mu.Lock()
	defer v.db.mu.Unlock()
	for _, r := range v.db.roles {
		if r.Name == name {
			return *r, nil
		}
	}
	return domain.Role{}, domain.ErrNotFound
}

func (v roleStoreView) GetMany(_ context.Context, ids []string) ([]domain.Role, error) {
	v.db.mu.Lock()
	defer v.db.mu.Unlock()
	var out []domain.Role
	for _, id := range ids {
		if r, ok := v.db.roles[id]; ok {
			out = append(out, *r)
		}
	}
	return out, nil
}

func (v roleStoreView) Create(_ context.Context, r domain.Role) error {
	v.db.mu.Lock()
	defer v.db.mu.Unlock()
	for _, x := range v.db.roles {
		if x.Name == r.Name {
			return domain.NewValidation(domain.FieldError{Field: "name", Reason: "already taken"})
		}
	}
	c := r
	v.db.roles[r.ID] = &c
	return nil
}

func (v roleStoreView) Update(_ context.Context, r domain.Role) error {
	v.db.mu.Lock()
	defer v.db.mu.Unlock()
	if _, ok := v.db.roles[r.ID]; !ok {
		return domain.ErrNotFound
	}
	c := r
	v.db.roles[r.ID] = &c
	return nil
}

func (v roleStoreView) Delete(_ context.Context, id string) error {
	v.db.mu.Lock()
	defer v.db.mu.Unlock()
	if v.db.userCount(id) > 0 {
		return domain.ErrRoleInUse
	}
	delete(v.db.roles, id)
	return nil
}

func (v roleStoreView) Users(_ context.Context, roleID string) ([]domain.UserRef, error) {
	v.db.mu.Lock()
	defer v.db.mu.Unlock()
	var out []domain.UserRef
	for uid, ids := range v.db.assign {
		if slices.Contains(ids, roleID) {
			out = append(out, domain.UserRef{ID: uid, DisplayName: v.db.users[uid].DisplayName})
		}
	}
	slices.SortFunc(out, func(a, b domain.UserRef) int { return strings.Compare(a.ID, b.ID) })
	return out, nil
}

func (v roleStoreView) UpsertCatalog(_ context.Context, cat []domain.PermissionInfo) (bool, error) {
	v.db.mu.Lock()
	defer v.db.mu.Unlock()
	changed := !slices.Equal(v.db.catalog, cat)
	v.db.catalog = slices.Clone(cat)
	return changed, nil
}

func (v roleStoreView) SetPermissions(_ context.Context, roleID string, perms []domain.Permission) (bool, error) {
	v.db.mu.Lock()
	defer v.db.mu.Unlock()
	r := v.db.roles[roleID]
	if r == nil {
		return false, domain.ErrNotFound
	}
	if slices.Equal(r.Permissions, perms) {
		return false, nil
	}
	r.Permissions = slices.Clone(perms)
	return true, nil
}

// AuthzState.

func (db *acctFakeDB) Epoch(context.Context) (int64, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	return db.epoch, nil
}

func (db *acctFakeDB) BumpEpoch(context.Context) (int64, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.epoch++
	db.bumps++
	return db.epoch, nil
}

var errBoom = errors.New("boom")
