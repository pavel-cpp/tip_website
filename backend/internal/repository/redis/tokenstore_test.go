package redis

import (
	"context"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"github.com/testcontainers/testcontainers-go"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

var (
	once sync.Once
	uri  string
	cerr error
)

// testClient returns a client on a throwaway Redis (REDIS_TEST_URL, else a container shared by
// the test binary) and skips when Docker is unavailable.
func testClient(t *testing.T) *goredis.Client {
	t.Helper()
	url := ""
	if v := os.Getenv("REDIS_TEST_URL"); v != "" {
		url = v
	} else {
		testcontainers.SkipIfProviderIsNotHealthy(t)
		once.Do(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			c, err := tcredis.Run(ctx, "redis:7-alpine")
			if err != nil {
				cerr = err
				return
			}
			uri, cerr = c.ConnectionString(ctx)
		})
		if cerr != nil {
			t.Skipf("redis test container unavailable: %v", cerr)
		}
		url = uri
	}
	c, err := Open(url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	if err := c.FlushAll(context.Background()).Err(); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestRevocationKeyScheme(t *testing.T) {
	c := testClient(t)
	s := NewTokenStore(c)
	ctx := context.Background()
	at := time.UnixMilli(1_790_000_000_123).UTC()

	if err := s.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	burned, when, err := s.BurnRefresh(ctx, "j1", at, time.Hour)
	if err != nil || !burned || !when.Equal(at) {
		t.Fatalf("burn = %v %v %v", burned, when, err)
	}
	if err := s.StoreReplay(ctx, "j1", "NEW-REFRESH", 10*time.Second); err != nil {
		t.Fatal(err)
	}
	if err := s.CloseFamily(ctx, "f1", time.Hour); err != nil {
		t.Fatal(err)
	}
	if err := s.RevokeAccess(ctx, "a1", time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := s.SetUserCutoff(ctx, "u1", at, time.Hour); err != nil {
		t.Fatal(err)
	}

	// Exactly the documented keys exist, with the documented values and TTLs.
	for key, want := range map[string]string{
		"rb:j1": "1790000000123", "rg:j1": "NEW-REFRESH", "revfam:f1": "1", "bl:jti:a1": "1", "bl:user:u1": "1790000000123",
	} {
		got, err := c.Get(ctx, key).Result()
		if err != nil || got != want {
			t.Errorf("%s = %q, %v; want %q", key, got, err, want)
		}
		if ttl := c.TTL(ctx, key).Val(); ttl <= 0 {
			t.Errorf("%s has no TTL (%v)", key, ttl)
		}
	}
	if ttl := c.TTL(ctx, "rg:j1").Val(); ttl > 10*time.Second {
		t.Errorf("rg TTL = %v", ttl)
	}
	if n := c.DBSize(ctx).Val(); n != 5 {
		t.Errorf("unexpected extra keys: %d", n)
	}

	st, err := s.Revocation(ctx, domain.RevocationQuery{AccessJTI: "a1", RefreshJTI: "j1", UserID: "u1", Family: "f1"})
	if err != nil {
		t.Fatal(err)
	}
	if !st.AccessRevoked || !st.FamilyClosed || !st.RefreshBurnedAt.Equal(at) || !st.UserCutoff.Equal(at) {
		t.Fatalf("state = %+v", st)
	}
	if !st.RevokedByCutoff(at) || st.RevokedByCutoff(at.Add(time.Millisecond)) {
		t.Fatal("cutoff comparison is strict: iat must be after the cutoff")
	}
}

func TestRevocationEmptyAndPartial(t *testing.T) {
	c := testClient(t)
	s := NewTokenStore(c)
	ctx := context.Background()
	st, err := s.Revocation(ctx, domain.RevocationQuery{})
	if err != nil || st != (domain.RevocationState{}) {
		t.Fatalf("empty query = %+v %v", st, err)
	}
	st, err = s.Revocation(ctx, domain.RevocationQuery{AccessJTI: "x", UserID: "y", Family: "z"})
	if err != nil || st != (domain.RevocationState{}) {
		t.Fatalf("clean state = %+v %v", st, err)
	}
	_ = s.RevokeAccess(ctx, "x", time.Minute)
	st, _ = s.Revocation(ctx, domain.RevocationQuery{AccessJTI: "x", UserID: "y"})
	if !st.AccessRevoked || st.FamilyClosed || !st.UserCutoff.IsZero() {
		t.Fatalf("state = %+v", st)
	}
}

func TestRevocationSingleRoundTrip(t *testing.T) {
	c := testClient(t)
	ctx := context.Background()
	var cmds atomic.Int32
	c.AddHook(countHook{&cmds})
	s := NewTokenStore(c)
	if _, err := s.Revocation(ctx, domain.RevocationQuery{AccessJTI: "a", RefreshJTI: "r", UserID: "u", Family: "f"}); err != nil {
		t.Fatal(err)
	}
	if cmds.Load() != 1 {
		t.Fatalf("commands = %d, want one MGET", cmds.Load())
	}
}

type countHook struct{ n *atomic.Int32 }

func (h countHook) DialHook(next goredis.DialHook) goredis.DialHook { return next }
func (h countHook) ProcessHook(next goredis.ProcessHook) goredis.ProcessHook {
	return func(ctx context.Context, cmd goredis.Cmder) error {
		h.n.Add(1)
		return next(ctx, cmd)
	}
}
func (h countHook) ProcessPipelineHook(next goredis.ProcessPipelineHook) goredis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []goredis.Cmder) error {
		h.n.Add(1)
		return next(ctx, cmds)
	}
}

func TestBurnRefreshIsExclusive(t *testing.T) {
	c := testClient(t)
	s := NewTokenStore(c)
	ctx := context.Background()
	first := time.UnixMilli(1_790_000_000_000).UTC()

	var wins atomic.Int32
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, _, err := s.BurnRefresh(ctx, "race", first.Add(time.Duration(i)*time.Millisecond), time.Hour)
			if err != nil {
				t.Error(err)
			}
			if ok {
				wins.Add(1)
			}
		}()
	}
	wg.Wait()
	if wins.Load() != 1 {
		t.Fatalf("%d winners, want exactly 1", wins.Load())
	}
	// A loser learns the winner's timestamp.
	ok, at, err := s.BurnRefresh(ctx, "race", first.Add(time.Hour), time.Hour)
	if err != nil || ok || at.Before(first) || at.After(first.Add(20*time.Millisecond)) {
		t.Fatalf("loser = %v %v %v", ok, at, err)
	}
}

func TestBurnRefreshTTLFollowsRemainingLife(t *testing.T) {
	c := testClient(t)
	s := NewTokenStore(c)
	ctx := context.Background()
	if _, _, err := s.BurnRefresh(ctx, "ttl", time.Now(), 90*time.Minute); err != nil {
		t.Fatal(err)
	}
	if ttl := c.TTL(ctx, "rb:ttl").Val(); ttl < 89*time.Minute || ttl > 90*time.Minute {
		t.Fatalf("ttl = %v", ttl)
	}
	// A non-positive remaining life still leaves a (short) mark.
	if _, _, err := s.BurnRefresh(ctx, "dead", time.Now(), -time.Hour); err != nil {
		t.Fatal(err)
	}
	if ttl := c.TTL(ctx, "rb:dead").Val(); ttl <= 0 {
		t.Fatalf("ttl = %v", ttl)
	}
}

func TestReplayWindowExpires(t *testing.T) {
	c := testClient(t)
	s := NewTokenStore(c)
	ctx := context.Background()
	if _, ok, err := s.Replay(ctx, "none"); ok || err != nil {
		t.Fatalf("missing replay = %v %v", ok, err)
	}
	if err := s.StoreReplay(ctx, "short", "tok", 1100*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if v, ok, err := s.Replay(ctx, "short"); !ok || v != "tok" || err != nil {
		t.Fatalf("replay = %q %v %v", v, ok, err)
	}
	time.Sleep(1300 * time.Millisecond)
	if _, ok, _ := s.Replay(ctx, "short"); ok {
		t.Fatal("replay entry must expire")
	}
}

func TestUnavailableRedisReturnsErrors(t *testing.T) {
	c, err := Open("redis://127.0.0.1:1/0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	s := NewTokenStore(c)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if s.Ping(ctx) == nil {
		t.Error("ping must fail")
	}
	if _, err := s.Revocation(ctx, domain.RevocationQuery{AccessJTI: "a"}); err == nil {
		t.Error("revocation must fail")
	}
	if _, _, err := s.BurnRefresh(ctx, "j", time.Now(), time.Hour); err == nil {
		t.Error("burn must fail")
	}
	if err := s.StoreReplay(ctx, "j", "t", time.Second); err == nil {
		t.Error("store replay must fail")
	}
	if _, _, err := s.Replay(ctx, "j"); err == nil {
		t.Error("replay must fail")
	}
	if err := s.CloseFamily(ctx, "f", time.Second); err == nil {
		t.Error("close family must fail")
	}
	if err := s.RevokeAccess(ctx, "a", time.Second); err == nil {
		t.Error("revoke access must fail")
	}
	if err := s.SetUserCutoff(ctx, "u", time.Now(), time.Second); err == nil {
		t.Error("cutoff must fail")
	}
}

func TestOpenRejectsBadURL(t *testing.T) {
	if _, err := Open("not a url"); err == nil {
		t.Fatal("bad URL accepted")
	}
}
