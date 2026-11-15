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
	keyRotation  = "rf:"       // rf:{fam}: hash {c: current refresh jti, p: previous jti, t: rotation time in unix ms}
	keyReplay    = "rg:"       // rg:{fam}: refresh token issued by the last rotation, kept for the replay window only
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

// rotateScript is the compare-and-swap on the current refresh jti of a family, run atomically
// inside Redis. KEYS: rotation hash, closed-family marker, replay token. ARGV: presented jti,
// new jti, new token, now (ms), replay window (ms), state TTL (ms), replay token TTL (ms).
// It answers {outcome, replay token}; the outcome numbers match domain.RotateOutcome.
//
// The first rotation of a family finds no state (login writes none) and accepts any presented
// token: it was signed by us and the family is not closed. A family whose state has expired has
// no live token left, because the state outlives the newest token it issued.
var rotateScript = goredis.NewScript(`
if redis.call('EXISTS', KEYS[2]) == 1 then return {3, ''} end
local st = redis.call('HMGET', KEYS[1], 'c', 'p', 't')
local cur = st[1]
if cur and cur ~= ARGV[1] then
  if st[2] == ARGV[1] and tonumber(ARGV[4]) - tonumber(st[3]) <= tonumber(ARGV[5]) then
    return {1, redis.call('GET', KEYS[3]) or ''}
  end
  return {2, ''}
end
redis.call('HSET', KEYS[1], 'c', ARGV[2], 'p', ARGV[1], 't', ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[6])
redis.call('SET', KEYS[3], ARGV[3], 'PX', ARGV[7])
return {0, ''}
`)

// replayGrace keeps the replay token slightly beyond the window; the window itself is judged by
// the stored rotation time, so an early expiry would only turn a replay into an error.
const replayGrace = 2 * time.Second

// RotateRefresh exchanges the current refresh token of a family for the next one. Per family
// Redis holds one small hash and one short-lived replay token, however often it rotates.
func (s *TokenStore) RotateRefresh(ctx context.Context, r domain.RefreshRotation) (domain.RotateResult, error) {
	res, err := rotateScript.Run(ctx, s.c,
		[]string{keyRotation + r.Family, keyFamily + r.Family, keyReplay + r.Family},
		r.Presented, r.NextJTI, r.NextToken, r.At.UnixMilli(), r.Window.Milliseconds(),
		ttlOrMin(r.TTL).Milliseconds(), (r.Window + replayGrace).Milliseconds(),
	).Slice()
	if err != nil {
		return domain.RotateResult{}, fmt.Errorf("redis rotate refresh: %w", err)
	}
	if len(res) != 2 {
		return domain.RotateResult{}, errors.New("redis rotate refresh: unexpected reply")
	}
	code, ok := res[0].(int64)
	if !ok {
		return domain.RotateResult{}, errors.New("redis rotate refresh: unexpected reply")
	}
	token, _ := res[1].(string)
	return domain.RotateResult{Outcome: domain.RotateOutcome(code), ReplayToken: token}, nil
}

// CloseFamily revokes a login chain and drops its rotation state, so a closed family costs one
// marker key. The marker is set first: rotateScript checks it, so no rotation can slip in
// between and recreate the state.
func (s *TokenStore) CloseFamily(ctx context.Context, family string, ttl time.Duration) error {
	_, err := s.c.TxPipelined(ctx, func(p goredis.Pipeliner) error {
		p.Set(ctx, keyFamily+family, "1", ttlOrMin(ttl))
		p.Del(ctx, keyRotation+family, keyReplay+family)
		return nil
	})
	if err != nil {
		return fmt.Errorf("redis close family: %w", err)
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
