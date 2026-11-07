package service

import (
	"context"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// TokenStore keeps the revocation state of tokens (Redis; docs/02-architecture.md, section 4.1).
// Any error it returns means the backend is unavailable.
type TokenStore interface {
	// Ping checks the backend is reachable.
	Ping(ctx context.Context) error
	// Revocation looks up all requested revocation keys in one round trip.
	Revocation(ctx context.Context, q domain.RevocationQuery) (domain.RevocationState, error)
	// BurnRefresh marks a refresh token id as used for ttl. burned is true only for the call
	// that created the mark; otherwise burnedAt is the time recorded by the winner.
	BurnRefresh(ctx context.Context, jti string, at time.Time, ttl time.Duration) (burned bool, burnedAt time.Time, err error)
	// StoreReplay remembers the refresh token issued in exchange for the burnt token jti.
	StoreReplay(ctx context.Context, jti, newRefresh string, ttl time.Duration) error
	// Replay returns the refresh token stored by StoreReplay while its window is open.
	Replay(ctx context.Context, jti string) (newRefresh string, ok bool, err error)
	// CloseFamily revokes a whole login chain.
	CloseFamily(ctx context.Context, family string, ttl time.Duration) error
	// RevokeAccess blacklists one access token id until its natural expiry.
	RevokeAccess(ctx context.Context, jti string, ttl time.Duration) error
	// SetUserCutoff invalidates every token of the user issued at or before cutoff.
	SetUserCutoff(ctx context.Context, userID string, cutoff time.Time, ttl time.Duration) error
}

// TokenCodec signs and verifies access and refresh JWTs. Verification errors are already
// domain errors (TOKEN_EXPIRED, UNAUTHENTICATED, REFRESH_INVALID).
type TokenCodec interface {
	IssueAccess(c domain.AccessClaims) (string, error)
	IssueRefresh(c domain.RefreshClaims) (string, error)
	VerifyAccess(token string, now time.Time) (domain.AccessClaims, error)
	VerifyRefresh(token string, now time.Time) (domain.RefreshClaims, error)
}

// PasswordHasher hashes and verifies passwords.
type PasswordHasher interface {
	Hash(ctx context.Context, password string) (string, error)
	// Verify checks password against hash. An empty hash must cost as much as a real one and
	// report false (unknown user). needsRehash asks the caller to store a fresh hash.
	Verify(ctx context.Context, password, hash string) (ok, needsRehash bool, err error)
}

// PasswordGenerator creates random temporary passwords.
type PasswordGenerator interface {
	NewPassword() (string, error)
}

// LoginLimiter throttles failed logins per IP and per IP+login pair.
type LoginLimiter interface {
	// Check returns a positive duration when the attempt must be rejected with RATE_LIMITED.
	Check(ip, login string) (retryAfter time.Duration)
	// Fail records a failed attempt.
	Fail(ip, login string)
	// Succeed clears the pair counter after a successful login.
	Succeed(ip, login string)
}

// ImageProcessor validates and normalizes uploaded avatars (implemented by the imaging stream).
type ImageProcessor interface {
	// ProcessAvatar decodes raw (PNG or JPEG), rejects hostile input with the domain errors
	// UNSUPPORTED_MEDIA, TOO_LARGE or IMAGE_INVALID and returns a 256x256 image.
	ProcessAvatar(ctx context.Context, raw []byte) (mime string, data []byte, err error)
}

// Audit records audited actions (implemented by the audit stream).
type Audit interface {
	Record(ctx context.Context, e domain.AuditEntry) error
}

// UserStore persists users. Every method joins the transaction carried by ctx.
type UserStore interface {
	// Create inserts a user; a taken login yields a validation error on "login".
	Create(ctx context.Context, u domain.NewUser) error
	GetByID(ctx context.Context, id string) (domain.UserRecord, error)
	GetByLogin(ctx context.Context, login string) (domain.UserRecord, error)
	List(ctx context.Context) ([]domain.UserRecord, error)
	UpdateProfile(ctx context.Context, id string, p domain.ProfilePatch) error
	SetPassword(ctx context.Context, id, hash string, temporary bool) error
	SetActive(ctx context.Context, id string, active bool) error
	TouchLastLogin(ctx context.Context, id string, at time.Time) error
	// SetRoles replaces the roles of the user.
	SetRoles(ctx context.Context, userID string, roleIDs []string) error
	// CountActiveAdmins counts active users holding the admin role. Inside a transaction it
	// first takes a lock that serializes concurrent admin-changing operations.
	CountActiveAdmins(ctx context.Context) (int, error)
}

// AvatarStore persists user avatars.
type AvatarStore interface {
	PutAvatar(ctx context.Context, userID string, a domain.Avatar, at time.Time) error
	// GetAvatar returns domain.ErrNotFound when the user has no avatar.
	GetAvatar(ctx context.Context, userID string) (domain.Avatar, error)
	DeleteAvatar(ctx context.Context, userID string) error
}

// RoleStore persists roles and the permission catalog.
type RoleStore interface {
	// List returns all roles with permissions and user counts.
	List(ctx context.Context) ([]domain.Role, error)
	Get(ctx context.Context, id string) (domain.Role, error)
	GetByName(ctx context.Context, name string) (domain.Role, error)
	// GetMany returns the roles with the given ids; missing ids are simply absent.
	GetMany(ctx context.Context, ids []string) ([]domain.Role, error)
	// Create inserts a role; a taken name yields a validation error on "name".
	Create(ctx context.Context, r domain.Role) error
	// Update stores name, description and the full permission list of the role.
	Update(ctx context.Context, r domain.Role) error
	// Delete removes a role; an assigned role yields domain.ErrRoleInUse.
	Delete(ctx context.Context, id string) error
	// Users returns the users holding the role.
	Users(ctx context.Context, roleID string) ([]domain.UserRef, error)
	// UpsertCatalog mirrors the permission catalog and removes codes no longer in it. It
	// reports whether anything changed.
	UpsertCatalog(ctx context.Context, catalog []domain.PermissionInfo) (changed bool, err error)
	// SetPermissions replaces the permissions of a role and reports whether they changed.
	SetPermissions(ctx context.Context, roleID string, perms []domain.Permission) (changed bool, err error)
}

// AuthzState stores the permission epoch.
type AuthzState interface {
	Epoch(ctx context.Context) (int64, error)
	// BumpEpoch increments the epoch inside the transaction carried by ctx and returns it.
	BumpEpoch(ctx context.Context) (int64, error)
}
