package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// RolePasswordChange is a reserved pseudo role placed in the access token of a user who must
// change a temporary password (FORCE_PASSWORD_CHANGE=true). The token then carries no
// permissions, and Authenticate reports PASSWORD_CHANGE_REQUIRED together with the actor so
// the transport can still let the allowed endpoints through. Role names cannot use it.
const RolePasswordChange = "_password_change"

// DefaultReplayWindow is how long a second use of a rotated refresh token is answered
// idempotently instead of being treated as theft.
const DefaultReplayWindow = 10 * time.Second

// cutoffTTLSlack keeps a user cutoff alive slightly longer than any token it can affect.
const cutoffTTLSlack = 60 * time.Second

// AuthConfig holds the token and policy settings of the auth service.
type AuthConfig struct {
	AccessTTL    time.Duration
	RefreshTTL   time.Duration
	ReplayWindow time.Duration // zero means DefaultReplayWindow
	// FailOpen selects REDIS_FAIL_MODE=open: when revocation lookups fail, Authenticate skips
	// them (reporting through OnTokenStoreError) instead of answering AUTH_UNAVAILABLE.
	FailOpen bool
	// ForcePasswordChange selects FORCE_PASSWORD_CHANGE=true.
	ForcePasswordChange bool
}

// AuthDeps are the collaborators of Auth.
type AuthDeps struct {
	Config  AuthConfig
	Users   UserStore
	Tokens  TokenStore
	Codec   TokenCodec
	Hasher  PasswordHasher
	Limiter LoginLimiter
	Audit   AccountAudit
	Epoch   *Epoch
	Clock   Clock
	IDs     IDGen
	// OnTokenStoreError is called with the underlying error whenever the token store fails, in
	// any mode. The service does not log; the composition root wires logging and metrics here.
	OnTokenStoreError func(op string, err error)
	// Sleep pauses between replay lookups; nil means time.Sleep.
	Sleep func(time.Duration)
}

// Auth implements login, token rotation, logout, password change and request authentication.
type Auth struct {
	AuthDeps
}

// NewAuth builds the auth service.
func NewAuth(d AuthDeps) *Auth {
	if d.Config.ReplayWindow <= 0 {
		d.Config.ReplayWindow = DefaultReplayWindow
	}
	if d.Sleep == nil {
		d.Sleep = time.Sleep
	}
	return &Auth{AuthDeps: d}
}

// Session is the result of a login, refresh or password change.
type Session struct {
	Pair domain.TokenPair
	// ExpiresIn is the access token lifetime in whole seconds.
	ExpiresIn int
	// User is set by Login.
	User Profile
}

// LoginInput is the credential submission with the client address used for throttling.
type LoginInput struct {
	Login    string
	Password string
	IP       string
}

func (a *Auth) storeErr(op string, err error) error {
	if a.OnTokenStoreError != nil {
		a.OnTokenStoreError(op, err)
	}
	// The cause stays out of the returned error: its text is shown to clients.
	return domain.ErrAuthUnavailable
}

func (a *Auth) audit(ctx context.Context, e domain.AccountAuditEntry) {
	if a.Audit == nil {
		return
	}
	// Login events are best effort: an audit outage must not lock users out.
	_ = a.Audit.Record(ctx, e)
}

// Login verifies credentials and issues a token pair.
func (a *Auth) Login(ctx context.Context, in LoginInput) (Session, error) {
	login := strings.ToLower(strings.TrimSpace(in.Login))
	var fields []domain.FieldError
	if login == "" {
		fields = append(fields, domain.FieldError{Field: "login", Reason: "is required"})
	}
	if in.Password == "" {
		fields = append(fields, domain.FieldError{Field: "password", Reason: "is required"})
	}
	if len(fields) > 0 {
		return Session{}, domain.NewValidation(fields...)
	}
	if wait := a.Limiter.Check(in.IP, login); wait > 0 {
		return Session{}, domain.NewRateLimited(wait)
	}
	if err := a.Tokens.Ping(ctx); err != nil {
		return Session{}, a.storeErr("login", err)
	}

	rec, err := a.Users.GetByLogin(ctx, login)
	hash := rec.PasswordHash
	switch {
	case errors.Is(err, domain.ErrNotFound):
		hash = "" // verified against a dummy hash below to keep timing uniform
	case err != nil:
		return Session{}, fmt.Errorf("find user: %w", err)
	}
	ok, rehash, err := a.Hasher.Verify(ctx, in.Password, hash)
	if err != nil {
		return Session{}, fmt.Errorf("verify password: %w", err)
	}
	if !ok || hash == "" || !rec.IsActive {
		a.Limiter.Fail(in.IP, login)
		a.audit(ctx, domain.AccountAuditEntry{Action: "login_failed", ActorID: rec.ID, IP: in.IP})
		return Session{}, domain.ErrBadCredentials
	}
	a.Limiter.Succeed(in.IP, login)

	if rehash {
		// Upgrading the stored hash is opportunistic; a failure must not block the login.
		if h, err := a.Hasher.Hash(ctx, in.Password); err == nil {
			_ = a.Users.SetPassword(ctx, rec.ID, h, rec.PasswordTemporary)
		}
	}
	now := a.Clock.Now()
	if err := a.Users.TouchLastLogin(ctx, rec.ID, now); err != nil {
		return Session{}, fmt.Errorf("record login time: %w", err)
	}
	rec.LastLoginAt = &now

	epoch := a.Epoch.Load()
	pair, err := a.issuePair(rec, a.IDs.NewID(), epoch, now, "")
	if err != nil {
		return Session{}, err
	}
	a.audit(ctx, domain.AccountAuditEntry{Action: "login", ActorID: rec.ID, IP: in.IP})
	return Session{Pair: pair, ExpiresIn: a.expiresIn(pair, now), User: ProfileOf(rec)}, nil
}

func (a *Auth) expiresIn(p domain.TokenPair, now time.Time) int {
	return max(0, int(p.AccessExpiresAt.Sub(now).Seconds()))
}

// issuePair signs a pair for rec. iat is the issue time; existingRefresh, when set, is reused
// instead of signing a new refresh token (idempotent replays).
func (a *Auth) issuePair(rec domain.UserRecord, family string, epoch int64, iat time.Time, existingRefresh string) (domain.TokenPair, error) {
	roles := make([]string, len(rec.Roles))
	for i, r := range rec.Roles {
		roles[i] = r.Name
	}
	perms := rec.Permissions
	if a.Config.ForcePasswordChange && rec.PasswordTemporary {
		roles, perms = []string{RolePasswordChange}, nil
	}
	pair := domain.TokenPair{
		AccessExpiresAt:  iat.Add(a.Config.AccessTTL),
		RefreshExpiresAt: iat.Add(a.Config.RefreshTTL),
		Family:           family,
	}
	var err error
	pair.AccessToken, err = a.Codec.IssueAccess(domain.AccessClaims{
		Subject: rec.ID, Roles: roles, Perms: perms, PermEpoch: epoch,
		TokenID: a.IDs.NewID(), Family: family, IssuedAt: iat, ExpiresAt: pair.AccessExpiresAt,
		Type: domain.TokenAccess,
	})
	if err != nil {
		return domain.TokenPair{}, fmt.Errorf("issue access token: %w", err)
	}
	if existingRefresh != "" {
		pair.RefreshToken = existingRefresh
		return pair, nil
	}
	pair.RefreshToken, err = a.Codec.IssueRefresh(domain.RefreshClaims{
		Subject: rec.ID, TokenID: a.IDs.NewID(), Family: family,
		IssuedAt: iat, ExpiresAt: pair.RefreshExpiresAt, Type: domain.TokenRefresh,
	})
	if err != nil {
		return domain.TokenPair{}, fmt.Errorf("issue refresh token: %w", err)
	}
	return pair, nil
}

// Refresh exchanges a refresh token for a new pair (docs/02-architecture.md, section 4.1).
func (a *Auth) Refresh(ctx context.Context, refreshToken string) (Session, error) {
	now := a.Clock.Now()
	claims, err := a.Codec.VerifyRefresh(refreshToken, now)
	if err != nil {
		return Session{}, err
	}
	st, err := a.Tokens.Revocation(ctx, domain.RevocationQuery{
		RefreshJTI: claims.TokenID, UserID: claims.Subject, Family: claims.Family,
	})
	if err != nil {
		return Session{}, a.storeErr("refresh", err)
	}
	if st.FamilyClosed || st.RevokedByCutoff(claims.IssuedAt) {
		return Session{}, domain.ErrRefreshInvalid
	}

	burnedAt := st.RefreshBurnedAt
	if burnedAt.IsZero() {
		burned, at, err := a.Tokens.BurnRefresh(ctx, claims.TokenID, now, claims.ExpiresAt.Sub(now))
		if err != nil {
			return Session{}, a.storeErr("refresh", err)
		}
		if burned {
			return a.rotate(ctx, claims, now)
		}
		burnedAt = at // lost a race with a concurrent exchange of the same token
	}
	return a.replay(ctx, claims, burnedAt, now)
}

// rotate issues the new pair after the old refresh token has been burnt.
func (a *Auth) rotate(ctx context.Context, claims domain.RefreshClaims, now time.Time) (Session, error) {
	epoch := a.Epoch.Load()
	rec, err := a.activeUser(ctx, claims.Subject)
	if err != nil {
		return Session{}, err
	}
	pair, err := a.issuePair(rec, claims.Family, epoch, now, "")
	if err != nil {
		return Session{}, err
	}
	if err := a.Tokens.StoreReplay(ctx, claims.TokenID, pair.RefreshToken, a.Config.ReplayWindow); err != nil {
		return Session{}, a.storeErr("refresh", err)
	}
	return Session{Pair: pair, ExpiresIn: a.expiresIn(pair, now), User: ProfileOf(rec)}, nil
}

// replay answers a second presentation of an already rotated refresh token: inside the replay
// window with the same new refresh token, later by closing the whole chain.
func (a *Auth) replay(ctx context.Context, claims domain.RefreshClaims, burnedAt, now time.Time) (Session, error) {
	if now.Sub(burnedAt) > a.Config.ReplayWindow {
		if err := a.Tokens.CloseFamily(ctx, claims.Family, a.Config.RefreshTTL); err != nil {
			return Session{}, a.storeErr("refresh", err)
		}
		return Session{}, domain.ErrRefreshInvalid
	}
	// The winner may still be issuing its pair; give it a moment to publish the replay entry.
	const attempts = 20
	var next string
	for i := range attempts {
		s, ok, err := a.Tokens.Replay(ctx, claims.TokenID)
		if err != nil {
			return Session{}, a.storeErr("refresh", err)
		}
		if ok {
			next = s
			break
		}
		if i < attempts-1 {
			a.Sleep(50 * time.Millisecond)
		}
	}
	if next == "" {
		return Session{}, domain.ErrRefreshInvalid
	}
	nextClaims, err := a.Codec.VerifyRefresh(next, now)
	if err != nil || nextClaims.Subject != claims.Subject || nextClaims.Family != claims.Family {
		return Session{}, domain.ErrRefreshInvalid
	}
	epoch := a.Epoch.Load()
	rec, err := a.activeUser(ctx, claims.Subject)
	if err != nil {
		return Session{}, err
	}
	pair, err := a.issuePair(rec, claims.Family, epoch, now, next)
	if err != nil {
		return Session{}, err
	}
	pair.RefreshExpiresAt = nextClaims.ExpiresAt
	return Session{Pair: pair, ExpiresIn: a.expiresIn(pair, now), User: ProfileOf(rec)}, nil
}

// activeUser loads the current user state for a refresh; a missing or deactivated user ends the chain.
func (a *Auth) activeUser(ctx context.Context, id string) (domain.UserRecord, error) {
	rec, err := a.Users.GetByID(ctx, id)
	if errors.Is(err, domain.ErrNotFound) {
		return domain.UserRecord{}, domain.ErrRefreshInvalid
	}
	if err != nil {
		return domain.UserRecord{}, fmt.Errorf("load user: %w", err)
	}
	if !rec.IsActive {
		return domain.UserRecord{}, domain.ErrRefreshInvalid
	}
	return rec, nil
}

// Logout blacklists the access token of the request and closes its refresh chain.
func (a *Auth) Logout(ctx context.Context, actor domain.Actor) error {
	now := a.Clock.Now()
	if ttl := actor.TokenExp.Sub(now); ttl > 0 {
		if err := a.Tokens.RevokeAccess(ctx, actor.TokenID, ttl); err != nil {
			return a.storeErr("logout", err)
		}
	}
	if err := a.Tokens.CloseFamily(ctx, actor.Family, a.Config.RefreshTTL); err != nil {
		return a.storeErr("logout", err)
	}
	return nil
}

// ChangePasswordInput carries the own-password change request.
type ChangePasswordInput struct {
	Current string
	New     string
	IP      string
}

// ChangePassword replaces the caller's password, revokes all earlier tokens of the user and
// issues a fresh pair whose iat is strictly after the revocation cutoff.
func (a *Auth) ChangePassword(ctx context.Context, actor domain.Actor, in ChangePasswordInput) (Session, error) {
	if err := domain.ValidatePassword("new", in.New); err != nil {
		return Session{}, err
	}
	throttleKey := "pw:" + actor.UserID
	if wait := a.Limiter.Check(in.IP, throttleKey); wait > 0 {
		return Session{}, domain.NewRateLimited(wait)
	}
	rec, err := a.Users.GetByID(ctx, actor.UserID)
	if errors.Is(err, domain.ErrNotFound) {
		return Session{}, domain.ErrUnauthenticated
	}
	if err != nil {
		return Session{}, fmt.Errorf("load user: %w", err)
	}
	if !rec.IsActive {
		return Session{}, domain.ErrUnauthenticated
	}
	ok, _, err := a.Hasher.Verify(ctx, in.Current, rec.PasswordHash)
	if err != nil {
		return Session{}, fmt.Errorf("verify password: %w", err)
	}
	if !ok {
		a.Limiter.Fail(in.IP, throttleKey)
		// Reported as a field error, not 401, so the client does not mistake it for a lost session.
		return Session{}, domain.NewValidation(domain.FieldError{Field: "current", Reason: "is incorrect"})
	}
	a.Limiter.Succeed(in.IP, throttleKey)

	hash, err := a.Hasher.Hash(ctx, in.New)
	if err != nil {
		return Session{}, fmt.Errorf("hash password: %w", err)
	}
	now := a.Clock.Now()
	cutoff := now.Truncate(time.Millisecond)
	if err := a.Tokens.SetUserCutoff(ctx, rec.ID, cutoff, a.Config.RefreshTTL+cutoffTTLSlack); err != nil {
		return Session{}, a.storeErr("change_password", err)
	}
	if err := a.Users.SetPassword(ctx, rec.ID, hash, false); err != nil {
		return Session{}, fmt.Errorf("store password: %w", err)
	}
	rec.PasswordTemporary = false

	iat := cutoff.Add(time.Millisecond)
	pair, err := a.issuePair(rec, a.IDs.NewID(), a.Epoch.Load(), iat, "")
	if err != nil {
		return Session{}, err
	}
	a.audit(ctx, domain.AccountAuditEntry{Action: "password.change", ActorID: rec.ID, TargetID: rec.ID, IP: in.IP})
	return Session{Pair: pair, ExpiresIn: a.expiresIn(pair, now), User: ProfileOf(rec)}, nil
}

// Authenticate verifies an access token and returns the actor. Permissions come from the token
// claims; the database is never consulted. When the user must change a temporary password
// (FORCE_PASSWORD_CHANGE) it returns the actor together with ErrPasswordChangeReq, so the
// transport can still serve the endpoints that are allowed in that state.
func (a *Auth) Authenticate(ctx context.Context, token string) (domain.Actor, error) {
	claims, err := a.Codec.VerifyAccess(token, a.Clock.Now())
	if err != nil {
		return domain.Actor{}, err
	}
	if claims.Stale(a.Epoch.Load()) {
		return domain.Actor{}, domain.ErrTokenStale
	}
	st, err := a.Tokens.Revocation(ctx, domain.RevocationQuery{
		AccessJTI: claims.TokenID, UserID: claims.Subject, Family: claims.Family,
	})
	switch {
	case err != nil && a.Config.FailOpen:
		// The blacklist is skipped; revoked tokens stay usable until exp (at most one access TTL).
		_ = a.storeErr("authenticate", err)
	case err != nil:
		return domain.Actor{}, a.storeErr("authenticate", err)
	case st.AccessRevoked || st.FamilyClosed || st.RevokedByCutoff(claims.IssuedAt):
		return domain.Actor{}, domain.ErrUnauthenticated
	}

	actor := claims.Actor()
	if len(claims.Roles) == 1 && claims.Roles[0] == RolePasswordChange {
		if !a.Config.ForcePasswordChange {
			// Issued under a stricter configuration: a refresh yields a normal token.
			return domain.Actor{}, domain.ErrTokenStale
		}
		actor.Roles, actor.Perms = nil, domain.NewPermissionSet()
		return actor, domain.ErrPasswordChangeReq
	}
	return actor, nil
}
