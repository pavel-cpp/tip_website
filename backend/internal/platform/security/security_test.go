package security

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

const (
	pepper1 = "0123456789abcdef0123456789abcdef"
	pepper2 = "fedcba9876543210fedcba9876543210"
	accSec  = "access-secret-access-secret-access-secret"
	refSec  = "refresh-secret-refresh-secret-refresh-sec"
)

func newHasher(t *testing.T) *Hasher {
	t.Helper()
	h, err := NewHasher(pepper1, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func TestHashVerifyRoundTrip(t *testing.T) {
	h := newHasher(t)
	ctx := context.Background()
	enc, err := h.Hash(ctx, "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(enc, "$argon2id$v=19$m=19456,t=2,p=1,pv=1$") {
		t.Fatalf("unexpected PHC string: %s", enc)
	}
	ok, rehash, err := h.Verify(ctx, "correct horse", enc)
	if err != nil || !ok || rehash {
		t.Fatalf("verify = %v %v %v", ok, rehash, err)
	}
	ok, _, err = h.Verify(ctx, "wrong", enc)
	if err != nil || ok {
		t.Fatalf("wrong password verified: %v %v", ok, err)
	}
	if h.NeedsRehash(enc) {
		t.Fatal("fresh hash must not need rehash")
	}
	enc2, _ := h.Hash(ctx, "correct horse")
	if enc == enc2 {
		t.Fatal("salt must differ between hashes")
	}
}

func TestPepperIsApplied(t *testing.T) {
	ctx := context.Background()
	a, _ := NewHasher(pepper1, 1, nil)
	enc, _ := a.Hash(ctx, "secret-pass")

	// Same version number but a different pepper must not verify.
	b, _ := NewHasher(pepper2, 1, nil)
	ok, _, err := b.Verify(ctx, "secret-pass", enc)
	if err != nil || ok {
		t.Fatalf("different pepper verified: %v %v", ok, err)
	}

	// The stored digest is the argon2 of HMAC(pepper, password), never of the plain password.
	mac := hmac.New(sha256.New, []byte(pepper1))
	mac.Write([]byte("secret-pass"))
	if len(mac.Sum(nil)) != 32 {
		t.Fatal("sanity")
	}
	if strings.Contains(enc, base64.RawStdEncoding.EncodeToString([]byte("secret-pass"))) {
		t.Fatal("hash leaks the password")
	}
}

func TestPepperRotation(t *testing.T) {
	ctx := context.Background()
	old, _ := NewHasher(pepper1, 1, nil)
	enc, _ := old.Hash(ctx, "pw-pw-pw-pw")

	rotated, err := NewHasher(pepper2, 2, map[int]string{1: pepper1})
	if err != nil {
		t.Fatal(err)
	}
	ok, rehash, err := rotated.Verify(ctx, "pw-pw-pw-pw", enc)
	if err != nil || !ok || !rehash {
		t.Fatalf("rotation verify = %v %v %v", ok, rehash, err)
	}
	if !rotated.NeedsRehash(enc) {
		t.Fatal("old pepper version must need rehash")
	}

	// Without the old pepper the hash cannot be checked at all.
	lost, _ := NewHasher(pepper2, 2, nil)
	if _, _, err := lost.Verify(ctx, "pw-pw-pw-pw", enc); !errors.Is(err, ErrInvalidHash) {
		t.Fatalf("err = %v", err)
	}
}

func TestNeedsRehashOnWeakParams(t *testing.T) {
	h := newHasher(t)
	weak := "$argon2id$v=19$m=4096,t=1,p=1,pv=1$c2FsdHNhbHRzYWx0c2FsdA$" + strings.Repeat("A", 43)
	if !h.NeedsRehash(weak) {
		t.Fatal("weak params must need rehash")
	}
	if !h.NeedsRehash("garbage") {
		t.Fatal("garbage must need rehash")
	}
}

func TestVerifyRejectsMalformed(t *testing.T) {
	h := newHasher(t)
	for _, enc := range []string{
		"garbage", "$bcrypt$x", "$argon2id$v=18$m=1,t=1,p=1$YQ$YQ",
		"$argon2id$v=19$m=999999999,t=2,p=1$YQ$" + strings.Repeat("A", 43),
		"$argon2id$v=19$m=19456,t=2,p=1$!!$!!",
		"$argon2id$v=19$m=x,t=2,p=1$YQ$YQ",
	} {
		if _, _, err := h.Verify(context.Background(), "x", enc); !errors.Is(err, ErrInvalidHash) {
			t.Errorf("%q: err = %v", enc, err)
		}
	}
}

func TestVerifyEmptyHashIsDummy(t *testing.T) {
	h := newHasher(t)
	ok, rehash, err := h.Verify(context.Background(), "anything", "")
	if err != nil || ok || rehash {
		t.Fatalf("got %v %v %v", ok, rehash, err)
	}
}

func TestHashRespectsContextWhenSaturated(t *testing.T) {
	h := newHasher(t)
	// Occupy both slots, then a canceled caller must give up instead of waiting.
	h.sem <- struct{}{}
	h.sem <- struct{}{}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := h.Hash(ctx, "x"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	<-h.sem
	<-h.sem
}

func TestConcurrencyLimit(t *testing.T) {
	h := newHasher(t)
	var cur, peak atomic.Int32
	var wg sync.WaitGroup
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, err := h.acquire(context.Background())
			if err != nil {
				t.Error(err)
				return
			}
			n := cur.Add(1)
			for {
				p := peak.Load()
				if n <= p || peak.CompareAndSwap(p, n) {
					break
				}
			}
			time.Sleep(10 * time.Millisecond)
			cur.Add(-1)
			release()
		}()
	}
	wg.Wait()
	if peak.Load() > maxConcurrentHashes {
		t.Fatalf("peak concurrency %d exceeds %d", peak.Load(), maxConcurrentHashes)
	}
}

func TestNewHasherValidation(t *testing.T) {
	if _, err := NewHasher("short", 1, nil); err == nil {
		t.Error("short pepper accepted")
	}
	if _, err := NewHasher(pepper1, 0, nil); err == nil {
		t.Error("zero version accepted")
	}
	if _, err := NewHasher(pepper1, 1, map[int]string{1: pepper2}); err == nil {
		t.Error("duplicate version accepted")
	}
}

func TestGeneratePassword(t *testing.T) {
	seen := map[string]bool{}
	for range 200 {
		p, err := GeneratePassword()
		if err != nil {
			t.Fatal(err)
		}
		if len(p) != 16 {
			t.Fatalf("len = %d", len(p))
		}
		if strings.ContainsAny(p, "0O1lI") {
			t.Fatalf("ambiguous char in %q", p)
		}
		for _, c := range p {
			if !strings.ContainsRune(tempPasswordAlphabet, c) {
				t.Fatalf("char %q outside alphabet", c)
			}
		}
		seen[p] = true
	}
	if len(seen) != 200 {
		t.Fatal("generated duplicates")
	}
	if _, err := (RandomPassword{}).NewPassword(); err != nil {
		t.Fatal(err)
	}
}

func newTokens(t *testing.T) *Tokens {
	t.Helper()
	tk, err := NewTokens(accSec, refSec)
	if err != nil {
		t.Fatal(err)
	}
	return tk
}

var t0 = time.Date(2026, 11, 8, 12, 0, 0, 123_000_000, time.UTC)

func accessClaims() domain.AccessClaims {
	return domain.AccessClaims{
		Subject: "u1", Roles: []string{"admin"}, Perms: []domain.Permission{"project.view", "role.manage"},
		PermEpoch: 7, TokenID: "j1", Family: "f1", IssuedAt: t0, ExpiresAt: t0.Add(15 * time.Minute),
	}
}

func TestAccessRoundTrip(t *testing.T) {
	tk := newTokens(t)
	s, err := tk.IssueAccess(accessClaims())
	if err != nil {
		t.Fatal(err)
	}
	got, err := tk.VerifyAccess(s, t0.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if got.Subject != "u1" || got.PermEpoch != 7 || got.TokenID != "j1" || got.Family != "f1" ||
		got.Type != domain.TokenAccess || len(got.Perms) != 2 || got.Roles[0] != "admin" {
		t.Fatalf("claims = %+v", got)
	}
	if !got.IssuedAt.Equal(t0) {
		t.Fatalf("millisecond precision lost: %v vs %v", got.IssuedAt, t0)
	}
}

func TestAccessEmptyListsEncodeAsArrays(t *testing.T) {
	tk := newTokens(t)
	c := accessClaims()
	c.Roles, c.Perms = nil, nil
	s, _ := tk.IssueAccess(c)
	payload := strings.Split(s, ".")[1]
	raw, _ := base64.RawURLEncoding.DecodeString(payload)
	if !strings.Contains(string(raw), `"roles":[]`) || !strings.Contains(string(raw), `"perms":[]`) {
		t.Fatalf("payload = %s", raw)
	}
}

func TestAccessExpired(t *testing.T) {
	tk := newTokens(t)
	s, _ := tk.IssueAccess(accessClaims())
	if _, err := tk.VerifyAccess(s, t0.Add(16*time.Minute)); !errors.Is(err, domain.ErrTokenExpired) {
		t.Fatalf("err = %v", err)
	}
}

func TestAccessRejectsRefreshTokenAndWrongSecret(t *testing.T) {
	tk := newTokens(t)
	r, _ := tk.IssueRefresh(domain.RefreshClaims{Subject: "u1", TokenID: "j", Family: "f", IssuedAt: t0, ExpiresAt: t0.Add(time.Hour)})
	if _, err := tk.VerifyAccess(r, t0); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("refresh accepted as access: %v", err)
	}
	a, _ := tk.IssueAccess(accessClaims())
	if _, err := tk.VerifyRefresh(a, t0); !errors.Is(err, domain.ErrRefreshInvalid) {
		t.Fatalf("access accepted as refresh: %v", err)
	}
}

// signWith signs arbitrary claims, bypassing Issue*, to craft hostile tokens.
func signWith(t *testing.T, method jwt.SigningMethod, key any, claims jwt.Claims) string {
	t.Helper()
	s, err := jwt.NewWithClaims(method, claims).SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestWrongTypeSameSecret(t *testing.T) {
	tk := newTokens(t)
	// A token signed with the access secret but typ=refresh must not pass either verifier.
	w := accessWire{stdClaims: std("u1", "j", t0, t0.Add(time.Hour)), Fam: "f", Typ: domain.TokenRefresh}
	s := signWith(t, jwt.SigningMethodHS256, []byte(accSec), w)
	if _, err := tk.VerifyAccess(s, t0); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("err = %v", err)
	}
}

func TestRejectsOtherAlgorithms(t *testing.T) {
	tk := newTokens(t)
	w := accessWire{stdClaims: std("u1", "j", t0, t0.Add(time.Hour)), Fam: "f", Typ: domain.TokenAccess}
	for name, s := range map[string]string{
		"none":  signWith(t, jwt.SigningMethodNone, jwt.UnsafeAllowNoneSignatureType, w),
		"HS384": signWith(t, jwt.SigningMethodHS384, []byte(accSec), w),
		"HS512": signWith(t, jwt.SigningMethodHS512, []byte(accSec), w),
	} {
		if _, err := tk.VerifyAccess(s, t0); !errors.Is(err, domain.ErrUnauthenticated) {
			t.Errorf("%s accepted: %v", name, err)
		}
	}
}

func TestRejectsMissingExpAndGarbage(t *testing.T) {
	tk := newTokens(t)
	w := accessWire{stdClaims: stdClaims{Subject: "u1", ID: "j"}, Fam: "f", Typ: domain.TokenAccess}
	s := signWith(t, jwt.SigningMethodHS256, []byte(accSec), w)
	if _, err := tk.VerifyAccess(s, t0); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("token without exp accepted: %v", err)
	}
	for _, g := range []string{"", "abc", "a.b.c"} {
		if _, err := tk.VerifyAccess(g, t0); !errors.Is(err, domain.ErrUnauthenticated) {
			t.Errorf("%q: %v", g, err)
		}
		if _, err := tk.VerifyRefresh(g, t0); !errors.Is(err, domain.ErrRefreshInvalid) {
			t.Errorf("%q: %v", g, err)
		}
	}
}

func TestRefreshRoundTripAndExpiry(t *testing.T) {
	tk := newTokens(t)
	c := domain.RefreshClaims{Subject: "u1", TokenID: "j9", Family: "f9", IssuedAt: t0, ExpiresAt: t0.Add(720 * time.Hour)}
	s, err := tk.IssueRefresh(c)
	if err != nil {
		t.Fatal(err)
	}
	got, err := tk.VerifyRefresh(s, t0.Add(time.Hour))
	if err != nil || got.TokenID != "j9" || got.Family != "f9" || got.Type != domain.TokenRefresh {
		t.Fatalf("got %+v err %v", got, err)
	}
	if _, err := tk.VerifyRefresh(s, t0.Add(721*time.Hour)); !errors.Is(err, domain.ErrRefreshInvalid) {
		t.Fatalf("expired refresh accepted: %v", err)
	}
}

func TestNewTokensValidation(t *testing.T) {
	if _, err := NewTokens("short", refSec); err == nil {
		t.Error("short secret accepted")
	}
	if _, err := NewTokens(accSec, accSec); err == nil {
		t.Error("equal secrets accepted")
	}
}
