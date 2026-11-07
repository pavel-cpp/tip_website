package domain

import "time"

// TokenType is the value of the typ claim. Checking it prevents a refresh
// token from being accepted as an access token and vice versa.
type TokenType string

// Token types.
const (
	TokenAccess  TokenType = "access"
	TokenRefresh TokenType = "refresh"
)

// AccessClaims is the decoded payload of an access JWT. It is plain data: signing
// and parsing live in the security platform package. The comments name the
// wire claim each field maps to.
type AccessClaims struct {
	Subject   string       // sub: user id
	Roles     []string     // roles: role names
	Perms     []Permission // perms: effective permission codes
	PermEpoch int64        // pe: permission epoch at issue time
	TokenID   string       // jti
	Family    string       // fam: login chain id
	IssuedAt  time.Time    // iat
	ExpiresAt time.Time    // exp
	Type      TokenType    // typ: always TokenAccess
}

// Expired reports whether the token is past its exp at `now`.
func (c AccessClaims) Expired(now time.Time) bool { return !now.Before(c.ExpiresAt) }

// Stale reports whether the permissions in the token predate currentEpoch.
func (c AccessClaims) Stale(currentEpoch int64) bool { return c.PermEpoch < currentEpoch }

// Actor builds the request Actor from verified claims.
func (c AccessClaims) Actor() Actor {
	return Actor{
		UserID:   c.Subject,
		Roles:    append([]string(nil), c.Roles...),
		Perms:    NewPermissionSet(c.Perms...),
		TokenID:  c.TokenID,
		Family:   c.Family,
		TokenExp: c.ExpiresAt,
		Epoch:    c.PermEpoch,
	}
}

// RefreshClaims is the decoded payload of a refresh JWT. It carries no permissions.
type RefreshClaims struct {
	Subject   string    // sub
	TokenID   string    // jti
	Family    string    // fam
	IssuedAt  time.Time // iat
	ExpiresAt time.Time // exp
	Type      TokenType // typ: always TokenRefresh
}

// Expired reports whether the token is past its exp at `now`.
func (c RefreshClaims) Expired(now time.Time) bool { return !now.Before(c.ExpiresAt) }

// TokenPair is a freshly issued access and refresh token.
type TokenPair struct {
	AccessToken      string
	AccessExpiresAt  time.Time
	RefreshToken     string
	RefreshExpiresAt time.Time
	Family           string
}
