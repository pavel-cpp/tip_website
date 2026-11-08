// Package redis stores token revocation state in Redis (docs/02-architecture.md, section 4.1).
package redis

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	goredis "github.com/redis/go-redis/v9"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// Key prefixes. The scheme is part of the operational contract (runbook, incident response).
const (
	keyBurnt     = "rb:"       // rb:{refresh jti}: rotated refresh token, value = burn time in unix ms
	keyReplay    = "rg:"       // rg:{refresh jti}: refresh token issued in exchange, 10 s window
	keyFamily    = "revfam:"   // revfam:{fam}: closed login chain
	keyAccessBL  = "bl:jti:"   // bl:jti:{access jti}: blacklisted access token
	keyUserBL    = "bl:user:"  // bl:user:{uid}: revocation cutoff in unix ms
	minKeyExpiry = time.Second // Redis rejects non-positive TTLs; an already dead token still gets a mark
)

// Open parses a redis:// URL and returns a client with short timeouts, so that a Redis outage
// fails requests quickly (REDIS_FAIL_MODE=open must not stall the API).
func Open(url string) (*goredis.Client, error) {
	opt, err := goredis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}
	opt.DialTimeout = 2 * time.Second
	opt.ReadTimeout = time.Second
	opt.WriteTimeout = time.Second
	opt.MaxRetries = 1
	return goredis.NewClient(opt), nil
}

// TokenStore implements the token revocation port on top of Redis.
type TokenStore struct {
	c goredis.Cmdable
}

// NewTokenStore wraps a client.
func NewTokenStore(c goredis.Cmdable) *TokenStore { return &TokenStore{c: c} }

func ttlOrMin(d time.Duration) time.Duration {
	if d < minKeyExpiry {
		return minKeyExpiry
	}
	return d
}

func ms(t time.Time) string { return strconv.FormatInt(t.UnixMilli(), 10) }

// Ping checks the connection.
func (s *TokenStore) Ping(ctx context.Context) error {
	if err := s.c.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("redis ping: %w", err)
	}
	return nil
}

// Revocation reads all requested keys with a single MGET.
func (s *TokenStore) Revocation(ctx context.Context, q domain.RevocationQuery) (domain.RevocationState, error) {
	type slot int
	const (
		slotAccess slot = iota
		slotBurnt
		slotFamily
		slotCutoff
	)
	var keys []string
	var slots []slot
	add := func(sl slot, key string) {
		keys = append(keys, key)
		slots = append(slots, sl)
	}
	if q.AccessJTI != "" {
		add(slotAccess, keyAccessBL+q.AccessJTI)
	}
	if q.RefreshJTI != "" {
		add(slotBurnt, keyBurnt+q.RefreshJTI)
	}
	if q.Family != "" {
		add(slotFamily, keyFamily+q.Family)
	}
	if q.UserID != "" {
		add(slotCutoff, keyUserBL+q.UserID)
	}
	var st domain.RevocationState
	if len(keys) == 0 {
		return st, nil
	}
	vals, err := s.c.MGet(ctx, keys...).Result()
	if err != nil {
		return domain.RevocationState{}, fmt.Errorf("redis mget: %w", err)
	}
	for i, v := range vals {
		str, ok := v.(string)
		if !ok {
			continue // key absent
		}
		switch slots[i] {
		case slotAccess:
			st.AccessRevoked = true
		case slotFamily:
			st.FamilyClosed = true
		case slotBurnt:
			st.RefreshBurnedAt = parseMillis(str)
		case slotCutoff:
			st.UserCutoff = parseMillis(str)
		}
	}
	return st, nil
}

// parseMillis decodes a unix-ms value; an unreadable value is treated as "now-ish revoked"
// (the epoch start would silently disable the mark), so it maps to a far-future time.
func parseMillis(s string) time.Time {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return time.UnixMilli(1<<62 - 1)
	}
	return time.UnixMilli(n).UTC()
}

// BurnRefresh marks the refresh token as used with SET NX, so that exactly one of several
// concurrent exchanges wins.
func (s *TokenStore) BurnRefresh(ctx context.Context, jti string, at time.Time, ttl time.Duration) (bool, time.Time, error) {
	key := keyBurnt + jti
	ok, err := s.c.SetNX(ctx, key, ms(at), ttlOrMin(ttl)).Result()
	if err != nil {
		return false, time.Time{}, fmt.Errorf("redis set nx: %w", err)
	}
	if ok {
		return true, at, nil
	}
	v, err := s.c.Get(ctx, key).Result()
	if errors.Is(err, goredis.Nil) {
		return false, at, nil // expired between the two calls: the token is dead anyway
	}
	if err != nil {
		return false, time.Time{}, fmt.Errorf("redis get: %w", err)
	}
	return false, parseMillis(v), nil
}

// StoreReplay saves the replacement refresh token for the idempotency window.
func (s *TokenStore) StoreReplay(ctx context.Context, jti, newRefresh string, ttl time.Duration) error {
	if err := s.c.Set(ctx, keyReplay+jti, newRefresh, ttlOrMin(ttl)).Err(); err != nil {
		return fmt.Errorf("redis set: %w", err)
	}
	return nil
}

// Replay returns the replacement refresh token while its window is open.
func (s *TokenStore) Replay(ctx context.Context, jti string) (string, bool, error) {
	v, err := s.c.Get(ctx, keyReplay+jti).Result()
	if errors.Is(err, goredis.Nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("redis get: %w", err)
	}
	return v, true, nil
}

// CloseFamily revokes a login chain.
func (s *TokenStore) CloseFamily(ctx context.Context, family string, ttl time.Duration) error {
	if err := s.c.Set(ctx, keyFamily+family, "1", ttlOrMin(ttl)).Err(); err != nil {
		return fmt.Errorf("redis set: %w", err)
	}
	return nil
}

// RevokeAccess blacklists an access token id.
func (s *TokenStore) RevokeAccess(ctx context.Context, jti string, ttl time.Duration) error {
	if err := s.c.Set(ctx, keyAccessBL+jti, "1", ttlOrMin(ttl)).Err(); err != nil {
		return fmt.Errorf("redis set: %w", err)
	}
	return nil
}

// SetUserCutoff records the revocation cutoff of a user (unix ms).
func (s *TokenStore) SetUserCutoff(ctx context.Context, userID string, cutoff time.Time, ttl time.Duration) error {
	if err := s.c.Set(ctx, keyUserBL+userID, ms(cutoff), ttlOrMin(ttl)).Err(); err != nil {
		return fmt.Errorf("redis set: %w", err)
	}
	return nil
}
