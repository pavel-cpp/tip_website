package redis

import (
	"context"
	"fmt"
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
	once      sync.Once
	uri       string
	cerr      error
	container *tcredis.RedisContainer
)

// TestMain removes the shared Redis container after the tests, whether or not the reaper runs.
func TestMain(m *testing.M) {
	code := m.Run()
	if container != nil {
		_ = testcontainers.TerminateContainer(container)
	}
	os.Exit(code)
}

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
			container = c
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

func rotation(fam, presented, next string, at time.Time) domain.RefreshRotation {
	return domain.RefreshRotation{
		Family: fam, Presented: presented, NextJTI: next, NextToken: "TOKEN-" + next,
		At: at, Window: 10 * time.Second, TTL: time.Hour,
	}
}

func TestRevocationKeyScheme(t *testing.T) {
	c := testClient(t)
	s := NewTokenStore(c)
	ctx := context.Background()
	at := time.UnixMilli(1_790_000_000_123).UTC()

	if err := s.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	res, err := s.RotateRefresh(ctx, rotation("f1", "j0", "j1", at))
	if err != nil || res.Outcome != domain.RotateOK {
		t.Fatalf("rotate = %+v %v", res, err)
	}
	if err := s.CloseFamily(ctx, "f2", time.Hour); err != nil {
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
		"rg:f1": "TOKEN-j1", "revfam:f2": "1", "bl:jti:a1": "1", "bl:user:u1": "1790000000123",
	} {
		got, err := c.Get(ctx, key).Result()
		if err != nil || got != want {
			t.Errorf("%s = %q, %v; want %q", key, got, err, want)
		}
	}
	state, err := c.HGetAll(ctx, "rf:f1").Result()
	if err != nil || len(state) != 3 || state["c"] != "j1" || state["p"] != "j0" || state["t"] != "1790000000123" {
		t.Errorf("rf:f1 = %v, %v", state, err)
	}
	for _, key := range []string{"rf:f1", "rg:f1", "revfam:f2", "bl:jti:a1", "bl:user:u1"} {
		if ttl := c.TTL(ctx, key).Val(); ttl <= 0 {
			t.Errorf("%s has no TTL (%v)", key, ttl)
		}
	}
	if ttl := c.TTL(ctx, "rf:f1").Val(); ttl < 59*time.Minute || ttl > time.Hour {
		t.Errorf("rf TTL = %v, want the new token's life", ttl)
	}
	if ttl := c.TTL(ctx, "rg:f1").Val(); ttl > 13*time.Second {
		t.Errorf("rg TTL = %v", ttl)
	}
	if n := c.DBSize(ctx).Val(); n != 5 {
		t.Errorf("unexpected extra keys: %d", n)
	}

	st, err := s.Revocation(ctx, domain.RevocationQuery{AccessJTI: "a1", UserID: "u1", Family: "f2"})
	if err != nil {
		t.Fatal(err)
	}
	if !st.AccessRevoked || !st.FamilyClosed || !st.UserCutoff.Equal(at) {
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
	if _, err := s.Revocation(ctx, domain.RevocationQuery{AccessJTI: "a", UserID: "u", Family: "f"}); err != nil {
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

func TestRotateRefreshIsExclusive(t *testing.T) {
	c := testClient(t)
	s := NewTokenStore(c)
	ctx := context.Background()
	first := time.UnixMilli(1_790_000_000_000).UTC()

	var wins, replays atomic.Int32
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := s.RotateRefresh(ctx, rotation("race", "j0", fmt.Sprintf("n%d", i), first.Add(time.Duration(i)*time.Millisecond)))
			if err != nil {
				t.Error(err)
			}
			switch res.Outcome {
			case domain.RotateOK:
				wins.Add(1)
			case domain.RotateReplay:
				replays.Add(1)
			}
		}()
	}
	wg.Wait()
	if wins.Load() != 1 || replays.Load() != 19 {
		t.Fatalf("%d winners and %d replays, want 1 and 19", wins.Load(), replays.Load())
	}
}

func TestRotateRefreshSemantics(t *testing.T) {
	c := testClient(t)
	s := NewTokenStore(c)
	ctx := context.Background()
	t0 := time.UnixMilli(1_790_000_000_000).UTC()
	rot := func(presented, next string, at time.Time) domain.RotateResult {
		t.Helper()
		res, err := s.RotateRefresh(ctx, rotation("f", presented, next, at))
		if err != nil {
			t.Fatal(err)
		}
		return res
	}

	if r := rot("j0", "j1", t0); r.Outcome != domain.RotateOK {
		t.Fatalf("first rotation = %+v", r)
	}
	// The replaced token inside the window gets the replacement back, and stays harmless.
	if r := rot("j0", "x", t0.Add(9*time.Second)); r.Outcome != domain.RotateReplay || r.ReplayToken != "TOKEN-j1" {
		t.Fatalf("replay = %+v", r)
	}
	// Exactly at the edge is still a replay; one millisecond later it is reuse.
	if r := rot("j0", "x", t0.Add(10*time.Second)); r.Outcome != domain.RotateReplay {
		t.Fatalf("edge = %+v", r)
	}
	if r := rot("j0", "x", t0.Add(10*time.Second+time.Millisecond)); r.Outcome != domain.RotateReuse {
		t.Fatalf("after the window = %+v", r)
	}
	// The current token keeps working, the one before the previous is reuse even inside the window.
	if r := rot("j1", "j2", t0.Add(time.Minute)); r.Outcome != domain.RotateOK {
		t.Fatalf("second rotation = %+v", r)
	}
	if r := rot("j0", "x", t0.Add(time.Minute+time.Second)); r.Outcome != domain.RotateReuse {
		t.Fatalf("older token = %+v", r)
	}
	if r := rot("stranger", "x", t0.Add(time.Minute+time.Second)); r.Outcome != domain.RotateReuse {
		t.Fatalf("unknown token = %+v", r)
	}
	// Closing the family wins over everything and frees the state.
	if err := s.CloseFamily(ctx, "f", time.Hour); err != nil {
		t.Fatal(err)
	}
	if r := rot("j2", "j3", t0.Add(2*time.Minute)); r.Outcome != domain.RotateClosed {
		t.Fatalf("closed = %+v", r)
	}
	if keys := c.Keys(ctx, "*").Val(); len(keys) != 1 || keys[0] != "revfam:f" {
		t.Fatalf("keys after close = %v", keys)
	}
}

func TestRotateRefreshStateStaysConstant(t *testing.T) {
	c := testClient(t)
	s := NewTokenStore(c)
	ctx := context.Background()
	at := time.Now()
	prev := "j0"
	for i := range 200 {
		next := fmt.Sprintf("j%d", i+1)
		if res, err := s.RotateRefresh(ctx, rotation("loop", prev, next, at.Add(time.Duration(i)*time.Second))); err != nil || res.Outcome != domain.RotateOK {
			t.Fatalf("rotation %d = %+v %v", i, res, err)
		}
		prev = next
	}
	if n := c.DBSize(ctx).Val(); n != 2 {
		t.Fatalf("%d keys after 200 rotations, want 2 (state + replay token)", n)
	}
}

func TestRotateRefreshTTLFollowsTokenLife(t *testing.T) {
	c := testClient(t)
	s := NewTokenStore(c)
	ctx := context.Background()
	r := rotation("ttl", "a", "b", time.Now())
	r.TTL = 90 * time.Minute
	if _, err := s.RotateRefresh(ctx, r); err != nil {
		t.Fatal(err)
	}
	if ttl := c.TTL(ctx, "rf:ttl").Val(); ttl < 89*time.Minute || ttl > 90*time.Minute {
		t.Fatalf("ttl = %v", ttl)
	}
	// A non-positive life still leaves a (short) state.
	r = rotation("dead", "a", "b", time.Now())
	r.TTL = -time.Hour
	if _, err := s.RotateRefresh(ctx, r); err != nil {
		t.Fatal(err)
	}
	if ttl := c.TTL(ctx, "rf:dead").Val(); ttl <= 0 {
		t.Fatalf("ttl = %v", ttl)
	}
}

func TestReplayTokenExpires(t *testing.T) {
	c := testClient(t)
	s := NewTokenStore(c)
	ctx := context.Background()
	r := rotation("short", "a", "b", time.Now())
	r.Window = 0 // the token is kept for the grace period only
	if _, err := s.RotateRefresh(ctx, r); err != nil {
		t.Fatal(err)
	}
	if ttl := c.TTL(ctx, "rg:short").Val(); ttl <= 0 || ttl > replayGrace {
		t.Fatalf("rg ttl = %v", ttl)
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
	if _, err := s.RotateRefresh(ctx, rotation("f", "a", "b", time.Now())); err == nil {
		t.Error("rotation must fail")
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
