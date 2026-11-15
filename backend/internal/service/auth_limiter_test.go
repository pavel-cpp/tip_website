package service

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// Parallel wrong guesses must be counted before the password check, otherwise every one of them
// would pass while the failure counter still reads zero.
func TestLoginBudgetHoldsUnderParallelAttempts(t *testing.T) {
	r := newRig(t, rigOpts{})
	var verified atomic.Int32
	r.hasher.slow = func() { verified.Add(1) }

	const attempts = 60
	var limited atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := r.auth.Login(context.Background(), LoginInput{Login: "admin", Password: "wrong", IP: "9.9.9.9"})
			if isErr(err, domain.ErrRateLimited) {
				limited.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	if got := verified.Load(); got > loginPairLimit {
		t.Fatalf("%d passwords were checked, budget is %d", got, loginPairLimit)
	}
	if got := limited.Load(); got < attempts-loginPairLimit {
		t.Fatalf("only %d of %d attempts were throttled", got, attempts)
	}
}

func TestLoginAttemptsBeyondInFlightCapAreRejectedAtOnce(t *testing.T) {
	c := newClock()
	l := NewMemoryLoginLimiter(c)
	var releases []func(bool)
	for i := range loginMaxInFlight {
		release, wait := l.Reserve(fmt.Sprintf("10.0.0.%d", i), "admin")
		if wait != 0 {
			t.Fatalf("attempt %d rejected: %v", i, wait)
		}
		releases = append(releases, release)
	}
	if _, wait := l.Reserve("10.0.1.1", "someone"); wait <= 0 {
		t.Fatal("the attempt above the cap must be rejected, not queued")
	}
	releases[0](false)
	releases[0](false) // a repeated release must not free a second slot
	release, wait := l.Reserve("10.0.1.1", "someone")
	if wait != 0 {
		t.Fatal("a slot was freed")
	}
	if _, wait := l.Reserve("10.0.1.2", "someone"); wait <= 0 {
		t.Fatal("double release freed an extra slot")
	}
	release(false)
}

func TestSuccessfulLoginsDoNotConsumeTheBudget(t *testing.T) {
	r := newRig(t, rigOpts{})
	for range 3 * loginIPLimit {
		r.login(t, "admin", "admin-pass")
	}
}

func TestLoginThrottleKeysIPv6ByPrefixAndMapsIPv4(t *testing.T) {
	l := NewMemoryLoginLimiter(newClock())
	for i := range loginPairLimit {
		// Same /64, different interface identifiers.
		release, wait := l.Reserve(fmt.Sprintf("2001:db8:1:2:%x::1", i+1), "admin")
		if wait != 0 {
			t.Fatalf("attempt %d rejected", i)
		}
		release(true)
	}
	if _, wait := l.Reserve("2001:db8:1:2:ffff::9", "admin"); wait <= 0 {
		t.Fatal("addresses of one /64 must share a budget")
	}
	if _, wait := l.Reserve("2001:db8:1:3::1", "admin"); wait != 0 {
		t.Fatal("another /64 must be independent")
	}
	for range loginPairLimit {
		release, _ := l.Reserve("::ffff:5.6.7.8", "bob")
		release(true)
	}
	if _, wait := l.Reserve("5.6.7.8", "bob"); wait <= 0 {
		t.Fatal("an IPv4-mapped address must count as the IPv4 address")
	}
	if got := limiterIP("not an ip"); got != "not an ip" {
		t.Fatalf("unparseable input must pass through, got %q", got)
	}
}

func TestLoginCeilingPerNameAcrossAddresses(t *testing.T) {
	l := NewMemoryLoginLimiter(newClock())
	for i := range loginNameLimit {
		release, wait := l.Reserve(fmt.Sprintf("10.1.%d.%d", i/200, i%200), "admin")
		if wait != 0 {
			t.Fatalf("attempt %d rejected", i)
		}
		release(true)
	}
	if _, wait := l.Reserve("10.9.9.9", "admin"); wait <= 0 {
		t.Fatal("the per-login ceiling must apply across addresses")
	}
	if _, wait := l.Reserve("10.9.9.9", "other"); wait != 0 {
		t.Fatal("other logins stay free")
	}
}

func TestWindowSetStaysBoundedAndSweepsCheaply(t *testing.T) {
	c := newClock()
	s := newWindowSet(time.Minute)
	for i := range 2 * limiterMaxKeys {
		s.add(fmt.Sprintf("k%d", i), c.Now())
	}
	if len(s.m) > limiterMaxKeys {
		t.Fatalf("map grew to %d entries", len(s.m))
	}
	c.Advance(time.Minute)
	s.add("fresh", c.Now())
	if len(s.m) != 1 {
		t.Fatalf("ended windows must be dropped, %d left", len(s.m))
	}
	if n := len(s.queue) - s.head; n != 1 {
		t.Fatalf("queue holds %d live entries", n)
	}
}

func TestFailedLoginAuditIsSampled(t *testing.T) {
	r := newRig(t, rigOpts{})
	ctx := context.Background()
	for range loginPairLimit {
		_, _ = r.auth.Login(ctx, LoginInput{Login: "admin", Password: "bad", IP: "9.9.9.9"})
	}
	// Rate-limited rejections never reach the password check and must not be audited.
	for range 3 {
		if _, err := r.auth.Login(ctx, LoginInput{Login: "admin", Password: "bad", IP: "9.9.9.9"}); !isErr(err, domain.ErrRateLimited) {
			t.Fatalf("err = %v", err)
		}
	}
	if got := r.audit.actions(); len(got) != 1 || got[0] != "login_failed" {
		t.Fatalf("audit = %v", got)
	}
	if n := r.audit.entries[0].Meta["count"]; n != 1 {
		t.Fatalf("meta = %v", r.audit.entries[0].Meta)
	}
}

func TestFailureAuditSamplerCountsSkippedFailures(t *testing.T) {
	c := newClock()
	f := newFailureAudit(c)
	if emit, n := f.sample("1.1.1.1", "x"); !emit || n != 1 {
		t.Fatalf("first: %v %d", emit, n)
	}
	for range 4 {
		if emit, _ := f.sample("1.1.1.1", "x"); emit {
			t.Fatal("repeats inside the window must be skipped")
		}
	}
	if emit, _ := f.sample("1.1.1.1", "y"); !emit {
		t.Fatal("another login has its own budget")
	}
	c.Advance(failureAuditWindow)
	if emit, n := f.sample("1.1.1.1", "x"); !emit || n != 5 {
		t.Fatalf("after the window: %v %d, want one row standing for 5 failures", emit, n)
	}
}
