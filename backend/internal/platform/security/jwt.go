package security

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

func init() {
	// Keep the library's own serialization at millisecond precision as well; the claims below
	// use msDate, which is exact, so tokens carry iat and exp as seconds with 3 decimals.
	jwt.TimePrecision = time.Millisecond
}

const minSecretLen = 32

// Tokens issues and verifies the access and refresh JWTs (HS256 only, different secrets).
type Tokens struct {
	accessSecret  []byte
	refreshSecret []byte
}

// NewTokens validates the secrets (>= 32 bytes, different from each other).
func NewTokens(accessSecret, refreshSecret string) (*Tokens, error) {
	if len(accessSecret) < minSecretLen || len(refreshSecret) < minSecretLen {
		return nil, errors.New("JWT secrets must be at least 32 bytes")
	}
	if accessSecret == refreshSecret {
		return nil, errors.New("JWT access and refresh secrets must differ")
	}
	return &Tokens{accessSecret: []byte(accessSecret), refreshSecret: []byte(refreshSecret)}, nil
}

// msDate is a Unix time in milliseconds, written as seconds with exactly three decimals
// ("1783512000.123"). The library's NumericDate parses through float64 and can lose the last
// millisecond, which would break the strict "iat > cutoff" ordering used after a password change.
type msDate int64

func newMSDate(t time.Time) msDate { return msDate(t.UnixMilli()) }

func (d msDate) time() time.Time { return time.UnixMilli(int64(d)).UTC() }

func (d msDate) MarshalJSON() ([]byte, error) {
	ms := int64(d)
	return []byte(fmt.Sprintf("%d.%03d", ms/1000, ms%1000)), nil
}

func (d *msDate) UnmarshalJSON(b []byte) error {
	whole, frac, _ := strings.Cut(string(b), ".")
	sec, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid time claim: %w", err)
	}
	for len(frac) < 3 {
		frac += "0"
	}
	ms, err := strconv.ParseInt(frac[:3], 10, 64)
	if err != nil {
		return fmt.Errorf("invalid time claim: %w", err)
	}
	*d = msDate(sec*1000 + ms)
	return nil
}

// stdClaims holds the registered claims shared by both token kinds and implements
// jwt.Claims so the library validates exp against the caller-supplied clock.
type stdClaims struct {
	Subject string `json:"sub"`
	ID      string `json:"jti"`
	Iat     msDate `json:"iat"`
	Exp     msDate `json:"exp"`
}

func (c stdClaims) GetExpirationTime() (*jwt.NumericDate, error) {
	if c.Exp == 0 {
		return nil, nil
	}
	return jwt.NewNumericDate(c.Exp.time()), nil
}
func (c stdClaims) GetIssuedAt() (*jwt.NumericDate, error) {
	return jwt.NewNumericDate(c.Iat.time()), nil
}
func (stdClaims) GetNotBefore() (*jwt.NumericDate, error) { return nil, nil }
func (stdClaims) GetIssuer() (string, error)              { return "", nil }
func (c stdClaims) GetSubject() (string, error)           { return c.Subject, nil }
func (stdClaims) GetAudience() (jwt.ClaimStrings, error)  { return nil, nil }

type accessWire struct {
	stdClaims
	Roles []string            `json:"roles"`
	Perms []domain.Permission `json:"perms"`
	PE    int64               `json:"pe"`
	Fam   string              `json:"fam"`
	Typ   domain.TokenType    `json:"typ"`
}

type refreshWire struct {
	stdClaims
	Fam string           `json:"fam"`
	Typ domain.TokenType `json:"typ"`
}

func std(sub, jti string, iat, exp time.Time) stdClaims {
	return stdClaims{Subject: sub, ID: jti, Iat: newMSDate(iat), Exp: newMSDate(exp)}
}

// IssueAccess signs access claims. The type claim is forced to "access".
func (t *Tokens) IssueAccess(c domain.AccessClaims) (string, error) {
	w := accessWire{
		stdClaims: std(c.Subject, c.TokenID, c.IssuedAt, c.ExpiresAt),
		Roles:     c.Roles,
		Perms:     c.Perms,
		PE:        c.PermEpoch,
		Fam:       c.Family,
		Typ:       domain.TokenAccess,
	}
	if w.Roles == nil {
		w.Roles = []string{}
	}
	if w.Perms == nil {
		w.Perms = []domain.Permission{}
	}
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, w).SignedString(t.accessSecret)
	if err != nil {
		return "", fmt.Errorf("sign access token: %w", err)
	}
	return s, nil
}

// IssueRefresh signs refresh claims. The type claim is forced to "refresh".
func (t *Tokens) IssueRefresh(c domain.RefreshClaims) (string, error) {
	w := refreshWire{
		stdClaims: std(c.Subject, c.TokenID, c.IssuedAt, c.ExpiresAt),
		Fam:       c.Family,
		Typ:       domain.TokenRefresh,
	}
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, w).SignedString(t.refreshSecret)
	if err != nil {
		return "", fmt.Errorf("sign refresh token: %w", err)
	}
	return s, nil
}

// parser pins the algorithm to HS256 (alg=none and RS/ES confusion are rejected) and judges
// expiry against the caller's clock. iat is not range-checked: a token issued after a
// revocation cutoff may legitimately carry an iat a millisecond ahead of the clock.
func parser(now time.Time) *jwt.Parser {
	return jwt.NewParser(
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithTimeFunc(func() time.Time { return now }),
		jwt.WithExpirationRequired(),
	)
}

// VerifyAccess checks signature, algorithm, expiry (against now) and typ. An expired but
// otherwise valid token yields domain.ErrTokenExpired; everything else is ErrUnauthenticated.
func (t *Tokens) VerifyAccess(token string, now time.Time) (domain.AccessClaims, error) {
	var w accessWire
	keyFn := func(*jwt.Token) (any, error) { return t.accessSecret, nil }
	if _, err := parser(now).ParseWithClaims(token, &w, keyFn); err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			return domain.AccessClaims{}, domain.ErrTokenExpired
		}
		return domain.AccessClaims{}, domain.ErrUnauthenticated
	}
	if w.Typ != domain.TokenAccess || w.Subject == "" || w.ID == "" || w.Fam == "" {
		return domain.AccessClaims{}, domain.ErrUnauthenticated
	}
	return domain.AccessClaims{
		Subject: w.Subject, Roles: w.Roles, Perms: w.Perms, PermEpoch: w.PE,
		TokenID: w.ID, Family: w.Fam, IssuedAt: w.Iat.time(), ExpiresAt: w.Exp.time(),
		Type: w.Typ,
	}, nil
}

// VerifyRefresh checks a refresh token; any failure is domain.ErrRefreshInvalid.
func (t *Tokens) VerifyRefresh(token string, now time.Time) (domain.RefreshClaims, error) {
	var w refreshWire
	keyFn := func(*jwt.Token) (any, error) { return t.refreshSecret, nil }
	if _, err := parser(now).ParseWithClaims(token, &w, keyFn); err != nil {
		return domain.RefreshClaims{}, domain.ErrRefreshInvalid
	}
	if w.Typ != domain.TokenRefresh || w.Subject == "" || w.ID == "" || w.Fam == "" {
		return domain.RefreshClaims{}, domain.ErrRefreshInvalid
	}
	return domain.RefreshClaims{
		Subject: w.Subject, TokenID: w.ID, Family: w.Fam,
		IssuedAt: w.Iat.time(), ExpiresAt: w.Exp.time(), Type: w.Typ,
	}, nil
}
