package domain

import "time"

// The types below are the data contract between the auth/user/role services and the
// repositories behind them. They live in domain because repositories may not import service,
// yet must implement the service ports with identical signatures.

// UserRecord is a user as stored: the public User plus the secrets and derived data that only
// services and repositories see. It must never be serialized to clients.
type UserRecord struct {
	User
	PasswordHash string
	// AvatarSHA is the SHA-256 (hex) of the avatar image, empty when the user has none.
	AvatarSHA string
	// Permissions is the union of the permissions of all the user's roles, in canonical order.
	Permissions []Permission
}

// NewUser is the input of UserStore.Create.
type NewUser struct {
	ID                string
	Login             string
	DisplayName       string
	Color             string
	PasswordHash      string
	PasswordTemporary bool
	CreatedAt         time.Time
}

// ProfilePatch lists the profile fields to change; nil fields stay untouched.
type ProfilePatch struct {
	DisplayName *string
	Color       *string
	Locale      *Locale
	Theme       *Theme
}

// Avatar is a processed avatar image.
type Avatar struct {
	MIME   string
	Data   []byte
	SHA256 string
}

// UserRef is a compact user reference used in role details.
type UserRef struct {
	ID          string
	DisplayName string
	Color       string
	AvatarSHA   string
}

// AuditEntry describes one audited action. Meta carries ids and counts only, never names,
// phone numbers or secrets. The audit implementation resolves the actor login itself.
type AuditEntry struct {
	Action   string
	ActorID  string
	TargetID string
	IP       string
	Meta     map[string]any
}

// RevocationQuery selects which revocation keys to look up in one round trip. Empty fields
// are skipped.
type RevocationQuery struct {
	AccessJTI  string
	RefreshJTI string
	UserID     string
	Family     string
}

// RevocationState is the answer to a RevocationQuery.
type RevocationState struct {
	// AccessRevoked is set when the access token id is blacklisted.
	AccessRevoked bool
	// RefreshBurnedAt is the moment the refresh token was rotated; zero when it was not.
	RefreshBurnedAt time.Time
	// FamilyClosed is set after logout or detected refresh reuse.
	FamilyClosed bool
	// UserCutoff invalidates every token of the user issued at or before it; zero when unset.
	UserCutoff time.Time
}

// RevokedByCutoff reports whether a token issued at iat predates the user cutoff.
func (s RevocationState) RevokedByCutoff(iat time.Time) bool {
	return !s.UserCutoff.IsZero() && !iat.After(s.UserCutoff)
}
