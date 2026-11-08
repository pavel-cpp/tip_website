package memory

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type countingMetrics struct {
	NopMetrics
	mu                       sync.Mutex
	conns, rooms, slow, conf int
	out                      map[string]int
	in                       map[string]int
}

func newCountingMetrics() *countingMetrics {
	return &countingMetrics{out: map[string]int{}, in: map[string]int{}}
}

func (m *countingMetrics) ConnectionOpened() { m.mu.Lock(); m.conns++; m.mu.Unlock() }
func (m *countingMetrics) ConnectionClosed() { m.mu.Lock(); m.conns--; m.mu.Unlock() }
func (m *countingMetrics) RoomOpened()       { m.mu.Lock(); m.rooms++; m.mu.Unlock() }
func (m *countingMetrics) RoomClosed()       { m.mu.Lock(); m.rooms--; m.mu.Unlock() }
func (m *countingMetrics) SlowClientDisconnect() {
	m.mu.Lock()
	m.slow++
	m.mu.Unlock()
}
func (m *countingMetrics) LockConflict()       { m.mu.Lock(); m.conf++; m.mu.Unlock() }
func (m *countingMetrics) MessageOut(t string) { m.mu.Lock(); m.out[t]++; m.mu.Unlock() }
func (m *countingMetrics) MessageIn(t string)  { m.mu.Lock(); m.in[t]++; m.mu.Unlock() }

func (m *countingMetrics) snapshot() (conns, rooms, slow, conf int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.conns, m.rooms, m.slow, m.conf
}

func peer(id string) domain.Peer {
	return domain.Peer{ID: id, DisplayName: "User " + id, Color: "#ffb84d", AvatarURL: ""}
}

type harness struct {
	t     *testing.T
	hub   *Hub
	clock *fakeClock
	met   *countingMetrics
}

func newHarness(t *testing.T, mod func(*Config)) *harness {
	t.Helper()
	h := &harness{t: t, clock: newFakeClock(), met: newCountingMetrics()}
	cfg := Config{Clock: h.clock, Metrics: h.met, SweepInterval: 5 * time.Millisecond}
	if mod != nil {
		mod(&cfg)
	}
	h.hub = NewHub(cfg)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := h.hub.Shutdown(ctx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
	})
	return h
}

func (h *harness) join(project, user string) domain.RoomSession {
	h.t.Helper()
	s, err := h.hub.Join(context.Background(), project, peer(user))
	if err != nil {
		h.t.Fatalf("join: %v", err)
	}
	return s
}

// next returns the next event or fails after a timeout.
func next(t *testing.T, s domain.RoomSession) domain.Event {
	t.Helper()
	select {
	case e := <-s.Events():
		return e
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for an event")
		return nil
	}
}

func expectNone(t *testing.T, s domain.RoomSession) {
	t.Helper()
	select {
	case e := <-s.Events():
		t.Fatalf("unexpected event %T %+v", e, e)
	case <-time.After(30 * time.Millisecond):
	}
}

func eventually(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("condition not met: %s", msg)
}

func TestJoinSnapshotAndPresence(t *testing.T) {
	h := newHarness(t, nil)
	a := h.join("p1", "alice")
	snap := a.Snapshot()
	if snap.You != "alice" || len(snap.Peers) != 1 || snap.Peers[0].DisplayName != "User alice" {
		t.Fatalf("unexpected snapshot %+v", snap)
	}
	if !snap.ServerTime.Equal(h.clock.Now()) {
		t.Fatalf("server time = %v", snap.ServerTime)
	}

	b := h.join("p1", "bob")
	if len(b.Snapshot().Peers) != 2 {
		t.Fatalf("bob sees %d peers", len(b.Snapshot().Peers))
	}
	pe, ok := next(t, a).(domain.PresenceEvent)
	if !ok || len(pe.Peers) != 2 {
		t.Fatalf("alice got %+v", pe)
	}
	expectNone(t, b)

	b.Leave()
	pe, ok = next(t, a).(domain.PresenceEvent)
	if !ok || len(pe.Peers) != 1 || pe.Peers[0].ID != "alice" {
		t.Fatalf("after leave alice got %+v", pe)
	}
}

func TestSecondTabOfSameUserKeepsPresence(t *testing.T) {
	h := newHarness(t, nil)
	a := h.join("p1", "alice")
	tab2 := h.join("p1", "alice")
	if len(tab2.Snapshot().Peers) != 1 {
		t.Fatalf("one user in two tabs must be one peer, got %d", len(tab2.Snapshot().Peers))
	}
	expectNone(t, a) // no presence change
	tab2.Leave()
	expectNone(t, a)
}

func TestRoomsAreIsolated(t *testing.T) {
	h := newHarness(t, nil)
	a := h.join("p1", "alice")
	b := h.join("p2", "bob")
	h.hub.Publish("p1", domain.RowsDeleted("r1"))
	if ev, ok := next(t, a).(domain.RowsDeletedEvent); !ok || ev.IDs[0] != "r1" {
		t.Fatalf("alice event = %+v", ev)
	}
	expectNone(t, b)
}

func TestPublishEvents(t *testing.T) {
	h := newHarness(t, nil)
	a := h.join("p1", "alice")
	b := h.join("p1", "bob")
	next(t, a) // presence

	h.hub.Publish("p1", domain.RowsUpserted(domain.Participant{ID: "r1", Version: 2}))
	h.hub.Publish("p1", domain.ProjectUpdated(domain.Project{ID: "p1"}))
	h.hub.Publish("nope", domain.RowsDeleted("x")) // unknown room: no-op
	for _, s := range []domain.RoomSession{a, b} {
		if ev, ok := next(t, s).(domain.RowsUpsertedEvent); !ok || ev.Items[0].Version != 2 {
			t.Fatalf("upsert = %+v", ev)
		}
		if ev, ok := next(t, s).(domain.ProjectUpdatedEvent); !ok || ev.Project.ID != "p1" {
			t.Fatalf("project = %+v", ev)
		}
	}
}

func TestCursorBroadcastExcludesSenderAndClearsOnLeave(t *testing.T) {
	h := newHarness(t, nil)
	a := h.join("p1", "alice")
	b := h.join("p1", "bob")
	next(t, a) // presence

	a.SetCursor(domain.Cursor{RowID: "r1", Field: "name"})
	ev, ok := next(t, b).(domain.CursorEvent)
	if !ok || ev.UserID != "alice" || ev.Cursor.RowID != "r1" || ev.Cursor.Field != "name" {
		t.Fatalf("cursor event = %+v", ev)
	}
	expectNone(t, a)

	c := h.join("p1", "carol")
	if cur := c.Snapshot().Cursors["alice"]; cur.RowID != "r1" {
		t.Fatalf("hello cursors = %+v", c.Snapshot().Cursors)
	}
	next(t, b) // presence of carol

	a.SetCursor(domain.Cursor{})
	ev, _ = next(t, b).(domain.CursorEvent)
	if ev.UserID != "alice" || ev.Cursor.RowID != "" {
		t.Fatalf("cleared cursor event = %+v", ev)
	}

	a.SetCursor(domain.Cursor{RowID: "r2"})
	next(t, b)
	a.Leave()
	// presence of carol join may precede; look for the cursor clear
	for i := 0; i < 4; i++ {
		if ce, ok := next(t, b).(domain.CursorEvent); ok {
			if ce.UserID != "alice" || ce.Cursor.RowID != "" {
				t.Fatalf("leave cursor event = %+v", ce)
			}
			return
		}
	}
	t.Fatal("no cursor clear on leave")
}

func TestLockLifecycle(t *testing.T) {
	h := newHarness(t, nil)
	a := h.join("p1", "alice")
	b := h.join("p1", "bob")
	next(t, a) // presence

	info, err := a.Acquire("r1")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if info.By != "alice" || !info.ExpiresAt.Equal(h.clock.Now().Add(domain.LockTTL)) {
		t.Fatalf("lock info = %+v", info)
	}
	for _, s := range []domain.RoomSession{a, b} {
		ev, ok := next(t, s).(domain.LockedEvent)
		if !ok || ev.RowID != "r1" || ev.By != "alice" {
			t.Fatalf("lock event = %+v", ev)
		}
	}

	// A conflicting acquire is denied and reports the owner.
	_, err = b.Acquire("r1")
	if !errors.Is(err, domain.ErrRowLocked) {
		t.Fatalf("expected ROW_LOCKED, got %v", err)
	}
	var de *domain.Error
	if !errors.As(err, &de) || de.Details["by"] != "alice" {
		t.Fatalf("owner missing in %v", err)
	}
	if _, _, _, conf := h.met.snapshot(); conf != 1 {
		t.Fatalf("lock conflicts = %d", conf)
	}

	// EnsureFree for the REST path.
	if err := h.hub.EnsureFree(context.Background(), "r1", "bob"); !errors.Is(err, domain.ErrRowLocked) {
		t.Fatalf("EnsureFree(bob) = %v", err)
	}
	if err := h.hub.EnsureFree(context.Background(), "r1", "alice"); err != nil {
		t.Fatalf("EnsureFree(alice) = %v", err)
	}
	if err := h.hub.EnsureFree(context.Background(), "other", "bob"); err != nil {
		t.Fatalf("EnsureFree(other) = %v", err)
	}

	// Non-owner release is ignored; owner release broadcasts unlock.
	b.Release("r1")
	expectNone(t, a)
	a.Release("r1")
	for _, s := range []domain.RoomSession{a, b} {
		ev, ok := next(t, s).(domain.UnlockedEvent)
		if !ok || ev.RowID != "r1" || ev.By != "alice" {
			t.Fatalf("unlock event = %+v", ev)
		}
	}
	if _, err := b.Acquire("r1"); err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
}

func TestLockExpiresWithoutHeartbeat(t *testing.T) {
	h := newHarness(t, nil)
	a := h.join("p1", "alice")
	b := h.join("p1", "bob")
	next(t, a)
	if _, err := a.Acquire("r1"); err != nil {
		t.Fatal(err)
	}
	next(t, a)
	next(t, b)

	h.clock.Advance(domain.LockTTL - time.Second)
	expectNone(t, b)
	if err := h.hub.EnsureFree(context.Background(), "r1", "bob"); err == nil {
		t.Fatal("lock must still be held")
	}

	h.clock.Advance(2 * time.Second)
	ev, ok := next(t, b).(domain.UnlockedEvent)
	if !ok || ev.RowID != "r1" {
		t.Fatalf("expected unlock, got %+v", ev)
	}
	if err := h.hub.EnsureFree(context.Background(), "r1", "bob"); err != nil {
		t.Fatalf("expired lock must be free: %v", err)
	}
}

func TestHeartbeatRenewsLocks(t *testing.T) {
	h := newHarness(t, nil)
	a := h.join("p1", "alice")
	b := h.join("p1", "bob")
	next(t, a)
	if _, err := a.Acquire("r1"); err != nil {
		t.Fatal(err)
	}
	next(t, a)
	next(t, b)

	h.clock.Advance(30 * time.Second)
	a.Heartbeat()
	ev, ok := next(t, b).(domain.LockedEvent)
	if !ok || !ev.ExpiresAt.Equal(h.clock.Now().Add(domain.LockTTL)) {
		t.Fatalf("renewed lock event = %+v", ev)
	}
	h.clock.Advance(30 * time.Second) // 60 s after acquire, 30 s after the heartbeat
	expectNone(t, b)
	if err := h.hub.EnsureFree(context.Background(), "r1", "bob"); !errors.Is(err, domain.ErrRowLocked) {
		t.Fatalf("lock must survive thanks to the heartbeat: %v", err)
	}
}

func TestLocksReleasedOnDisconnect(t *testing.T) {
	h := newHarness(t, nil)
	a := h.join("p1", "alice")
	b := h.join("p1", "bob")
	next(t, a)
	for _, r := range []string{"r1", "r2"} {
		if _, err := a.Acquire(r); err != nil {
			t.Fatal(err)
		}
	}
	a.Leave()
	unlocked := map[string]bool{}
	for len(unlocked) < 2 {
		switch ev := next(t, b).(type) {
		case domain.UnlockedEvent:
			unlocked[ev.RowID] = true
		case domain.LockedEvent, domain.PresenceEvent:
		default:
			t.Fatalf("unexpected %T", ev)
		}
	}
	if err := h.hub.EnsureFree(context.Background(), "r1", "bob"); err != nil {
		t.Fatalf("lock must be gone: %v", err)
	}
}

func TestSameUserSecondTabMayTakeOverOwnLock(t *testing.T) {
	h := newHarness(t, nil)
	tab1 := h.join("p1", "alice")
	tab2 := h.join("p1", "alice")
	if _, err := tab1.Acquire("r1"); err != nil {
		t.Fatal(err)
	}
	if _, err := tab2.Acquire("r1"); err != nil {
		t.Fatalf("own lock from another tab: %v", err)
	}
	tab1.Leave() // tab 2 now holds the lock, so it survives
	other := h.join("p1", "bob")
	if _, ok := other.Snapshot().Locks["r1"]; !ok {
		t.Fatal("lock taken over by tab 2 must survive tab 1 leaving")
	}
}

func TestHelloContainsLiveLocks(t *testing.T) {
	h := newHarness(t, nil)
	a := h.join("p1", "alice")
	if _, err := a.Acquire("r1"); err != nil {
		t.Fatal(err)
	}
	b := h.join("p1", "bob")
	l, ok := b.Snapshot().Locks["r1"]
	if !ok || l.By != "alice" {
		t.Fatalf("hello locks = %+v", b.Snapshot().Locks)
	}
}

func TestLockLimitPerSession(t *testing.T) {
	h := newHarness(t, nil)
	a := h.join("p1", "alice")
	for i := 0; i < maxLocksPerSession; i++ {
		if _, err := a.Acquire(fmt.Sprintf("r%d", i)); err != nil {
			t.Fatalf("acquire %d: %v", i, err)
		}
	}
	if _, err := a.Acquire("overflow"); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("expected validation error, got %v", err)
	}
	if _, err := a.Acquire("r0"); err != nil {
		t.Fatalf("renewing a held lock must still work: %v", err)
	}
}

func TestSlowClientIsDisconnected(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.SendBuffer = 4 })
	fast := h.join("p1", "fast")
	slow := h.join("p1", "slow")
	next(t, fast) // presence

	sawPresence := false
	for i := 0; i < 10; i++ { // slow never reads
		h.hub.Publish("p1", domain.RowsDeleted(fmt.Sprint(i)))
		for { // fast keeps up and drains everything queued so far
			select {
			case ev := <-fast.Events():
				if pe, ok := ev.(domain.PresenceEvent); ok && len(pe.Peers) == 1 {
					sawPresence = true
				}
				continue
			case <-time.After(5 * time.Millisecond):
			}
			break
		}
	}
	select {
	case <-slow.Closed():
	case <-time.After(2 * time.Second):
		t.Fatal("slow client was not closed")
	}
	if slow.CloseReason() != domain.CloseSlow {
		t.Fatalf("reason = %v", slow.CloseReason())
	}
	eventually(t, func() bool {
		conns, _, slowCount, _ := h.met.snapshot()
		return conns == 1 && slowCount == 1
	}, "slow client accounted and removed")
	for !sawPresence {
		select {
		case ev := <-fast.Events():
			if pe, ok := ev.(domain.PresenceEvent); ok && len(pe.Peers) == 1 {
				sawPresence = true
			}
		case <-time.After(500 * time.Millisecond):
			t.Fatal("fast client did not receive the presence update after the slow client left")
		}
	}
}

func TestSlowClientReleasesItsLocks(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.SendBuffer = 2 })
	slow := h.join("p1", "slow")
	if _, err := slow.Acquire("r1"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		h.hub.Publish("p1", domain.RowsDeleted("x"))
	}
	<-slow.Closed()
	eventually(t, func() bool { return h.hub.EnsureFree(context.Background(), "r1", "bob") == nil }, "lock released")
}

func TestKickUser(t *testing.T) {
	h := newHarness(t, nil)
	a1 := h.join("p1", "alice")
	a2 := h.join("p2", "alice")
	b := h.join("p1", "bob")
	next(t, a1)
	if _, err := a1.Acquire("r1"); err != nil {
		t.Fatal(err)
	}

	h.hub.KickUser("alice")
	for _, s := range []domain.RoomSession{a1, a2} {
		select {
		case <-s.Closed():
		case <-time.After(2 * time.Second):
			t.Fatal("session not kicked")
		}
		if s.CloseReason() != domain.CloseKicked {
			t.Fatalf("reason = %v", s.CloseReason())
		}
	}
	select {
	case <-b.Closed():
		t.Fatal("bob must not be kicked")
	default:
	}
	eventually(t, func() bool { return h.hub.EnsureFree(context.Background(), "r1", "bob") == nil }, "kicked user's lock released")
}

func TestBroadcastReauth(t *testing.T) {
	h := newHarness(t, nil)
	a := h.join("p1", "alice")
	b := h.join("p2", "bob")

	h.hub.BroadcastReauth("alice")
	if ev, ok := next(t, a).(domain.ReauthEvent); !ok || ev.UserID != "alice" {
		t.Fatalf("alice reauth = %+v", ev)
	}
	expectNone(t, b)

	h.hub.BroadcastReauth("")
	if _, ok := next(t, a).(domain.ReauthEvent); !ok {
		t.Fatal("alice must get a global reauth")
	}
	if _, ok := next(t, b).(domain.ReauthEvent); !ok {
		t.Fatal("bob must get a global reauth")
	}

	h.hub.Publish("p2", domain.Reauth("bob"))
	if _, ok := next(t, b).(domain.ReauthEvent); !ok {
		t.Fatal("published reauth must reach the room")
	}
}

func TestRoomsRemovedWhenEmpty(t *testing.T) {
	h := newHarness(t, nil)
	a := h.join("p1", "alice")
	b := h.join("p1", "bob")
	if _, rooms, _, _ := h.met.snapshot(); rooms != 1 {
		t.Fatalf("rooms = %d", rooms)
	}
	a.Leave()
	b.Leave()
	b.Leave() // idempotent
	eventually(t, func() bool {
		conns, rooms, _, _ := h.met.snapshot()
		return conns == 0 && rooms == 0
	}, "room removed")
	h.hub.mu.RLock()
	n := len(h.hub.rooms)
	h.hub.mu.RUnlock()
	if n != 0 {
		t.Fatalf("registry still holds %d rooms", n)
	}
	// The project can be joined again afterwards.
	c := h.join("p1", "carol")
	if len(c.Snapshot().Peers) != 1 {
		t.Fatalf("peers = %+v", c.Snapshot().Peers)
	}
}

func TestRateLimiter(t *testing.T) {
	h := newHarness(t, nil)
	a := h.join("p1", "alice")
	for i := 0; i < 20; i++ {
		if !a.Allow() {
			t.Fatalf("message %d must be allowed", i)
		}
	}
	if a.Allow() {
		t.Fatal("21st message in the same instant must be denied")
	}
	h.clock.Advance(100 * time.Millisecond) // 2 tokens
	for i := 0; i < 2; i++ {
		if !a.Allow() {
			t.Fatal("tokens must refill with time")
		}
	}
	if a.Allow() {
		t.Fatal("only two tokens were refilled")
	}
	h.clock.Advance(time.Hour)
	for i := 0; i < 20; i++ {
		if !a.Allow() {
			t.Fatal("bucket must refill to the burst size")
		}
	}
	if a.Allow() {
		t.Fatal("burst must be capped")
	}
}

func TestShutdownClosesSessionsAndRefusesJoins(t *testing.T) {
	clock := newFakeClock()
	hub := NewHub(Config{Clock: clock})
	a, err := hub.Join(context.Background(), "p1", peer("alice"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Acquire("r1"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := hub.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-a.Closed():
	default:
		t.Fatal("session must be closed")
	}
	if a.CloseReason() != domain.CloseShutdown {
		t.Fatalf("reason = %v", a.CloseReason())
	}
	if _, err := hub.Join(context.Background(), "p1", peer("bob")); !errors.Is(err, ErrHubClosed) {
		t.Fatalf("join after shutdown = %v", err)
	}
	a.Leave() // must not block
	if _, err := a.Acquire("r2"); err == nil {
		t.Fatal("acquire after shutdown must fail")
	}
}

func TestJoinHonoursCancelledContext(t *testing.T) {
	h := newHarness(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := h.hub.Join(ctx, "p1", peer("alice")); err == nil {
		t.Fatal("expected context error")
	}
}

func TestMetricsCountMessages(t *testing.T) {
	h := newHarness(t, nil)
	a := h.join("p1", "alice")
	b := h.join("p1", "bob")
	next(t, a)
	a.SetCursor(domain.Cursor{RowID: "r1"})
	next(t, b)
	a.Heartbeat()
	if _, err := a.Acquire("r1"); err != nil {
		t.Fatal(err)
	}
	a.Release("r1")
	eventually(t, func() bool {
		h.met.mu.Lock()
		defer h.met.mu.Unlock()
		return h.met.out["unlock"] == 2 && h.met.out["lock"] == 2 && h.met.out["cursor"] == 1
	}, "out counters")
	h.met.mu.Lock()
	defer h.met.mu.Unlock()
	for _, k := range []string{"cursor", "ping", "lock.acquire", "lock.release"} {
		if h.met.in[k] != 1 {
			t.Errorf("in[%s] = %d", k, h.met.in[k])
		}
	}
}

func TestConcurrentTrafficRace(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Clock = nil })
	const users = 12
	var wg sync.WaitGroup
	for u := 0; u < users; u++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for round := 0; round < 20; round++ {
				s, err := h.hub.Join(context.Background(), fmt.Sprintf("p%d", u%3), peer(fmt.Sprintf("u%d", u)))
				if err != nil {
					t.Errorf("join: %v", err)
					return
				}
				stop := make(chan struct{})
				var drain sync.WaitGroup
				drain.Add(1)
				go func() {
					defer drain.Done()
					for {
						select {
						case <-s.Events():
						case <-s.Closed():
							return
						case <-stop:
							return
						}
					}
				}()
				_, _ = s.Acquire(fmt.Sprintf("r%d", round%4))
				s.SetCursor(domain.Cursor{RowID: "r1"})
				s.Heartbeat()
				h.hub.Publish(fmt.Sprintf("p%d", u%3), domain.RowsDeleted("x"))
				_ = h.hub.EnsureFree(context.Background(), "r1", "zed")
				s.Release(fmt.Sprintf("r%d", round%4))
				s.Leave()
				close(stop)
				drain.Wait()
			}
		}()
	}
	wg.Wait()
	eventually(t, func() bool {
		conns, rooms, _, _ := h.met.snapshot()
		return conns == 0 && rooms == 0
	}, "everything cleaned up")
}
