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

// AccountAuditEntry describes one audited account action. Meta carries ids and counts only, plus the target
// login of account actions; never display names, phone numbers or secrets. The audit implementation resolves the actor login itself.
type AccountAuditEntry struct {
	Action   string
	ActorID  string
	TargetID string
	IP       string
	Meta     map[string]any
}

// RevocationQuery selects which revocation keys to look up in one round trip. Empty fields
// are skipped.
type RevocationQuery struct {
	AccessJTI string
	UserID    string
	Family    string
}

// RevocationState is the answer to a RevocationQuery.
type RevocationState struct {
	// AccessRevoked is set when the access token id is blacklisted.
	AccessRevoked bool
	// FamilyClosed is set after logout or detected refresh reuse.
	FamilyClosed bool
	// UserCutoff invalidates every token of the user issued at or before it; zero when unset.
	UserCutoff time.Time
}

// RotateOutcome is the verdict of a refresh rotation attempt.
type RotateOutcome int

// Rotation verdicts.
const (
	// RotateOK means the presented token was the current one of its family and the family now
	// holds the new token.
	RotateOK RotateOutcome = iota
	// RotateReplay means the presented token was the one rotated just before, inside the replay
	// window; ReplayToken is the refresh token issued in exchange (empty if it is already gone).
	RotateReplay
	// RotateReuse means an already rotated token was presented outside the window: theft.
	RotateReuse
	// RotateClosed means the family was closed (logout, reuse) before or during the attempt.
	RotateClosed
)

// RefreshRotation is the input of TokenStore.RotateRefresh. The new token is issued before the
// call so that publishing it and retiring the old one is a single atomic step.
type RefreshRotation struct {
	Family string
	// Presented is the jti of the refresh token being exchanged; NextJTI and NextToken are the
	// jti and the encoded form of its replacement.
	Presented, NextJTI, NextToken string
	At                            time.Time
	// Window is the idempotent replay window; TTL is the lifetime of the new token, which the
	// family state must outlive.
	Window, TTL time.Duration
}

// RotateResult is the answer to a RefreshRotation.
type RotateResult struct {
	Outcome     RotateOutcome
	ReplayToken string
}

// RevokedByCutoff reports whether a token issued at iat predates the user cutoff.
func (s RevocationState) RevokedByCutoff(iat time.Time) bool {
	return !s.UserCutoff.IsZero() && !iat.After(s.UserCutoff)
}
