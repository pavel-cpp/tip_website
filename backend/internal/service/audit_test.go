package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

type fakeAuditStore struct {
	inserted []domain.AuditEntry
	listed   []domain.AuditFilter
	rows     []domain.AuditEntry
	insErr   error

	// retention: remaining rows that match each rule
	old, excess       int
	ageCalls, maxCall []int
	cutoff            time.Time
	keep              int
}

func (f *fakeAuditStore) Insert(_ context.Context, e domain.AuditEntry) error {
	if f.insErr != nil {
		return f.insErr
	}
	f.inserted = append(f.inserted, e)
	return nil
}

func (f *fakeAuditStore) List(_ context.Context, flt domain.AuditFilter) ([]domain.AuditEntry, error) {
	f.listed = append(f.listed, flt)
	n := min(flt.Limit, len(f.rows))
	return f.rows[:n], nil
}

func take(remaining *int, batch int) int {
	n := min(*remaining, batch)
	*remaining -= n
	return n
}

func (f *fakeAuditStore) DeleteOlderThan(_ context.Context, cutoff time.Time, batch int) (int, error) {
	f.cutoff = cutoff
	n := take(&f.old, batch)
	f.ageCalls = append(f.ageCalls, n)
	return n, nil
}

func (f *fakeAuditStore) DeleteBeyondMax(_ context.Context, keep, batch int) (int, error) {
	f.keep = keep
	n := take(&f.excess, batch)
	f.maxCall = append(f.maxCall, n)
	return n, nil
}

func newAudit(store *fakeAuditStore, cfg AuditConfig) *Audit {
	return NewAudit(store, &ptFixedClock{testNow}, cfg)
}

func TestAuditRecord(t *testing.T) {
	st := &fakeAuditStore{}
	s := newAudit(st, AuditConfig{})
	ctx := WithClientIP(context.Background(), "203.0.113.9:51234")
	err := s.Record(ctx, ptActorWith("u1"), "tickets.print", "p1", "e1", map[string]any{"count": 3})
	if err != nil {
		t.Fatal(err)
	}
	e := st.inserted[0]
	if e.ActorID != "u1" || e.Action != "tickets.print" || e.ProjectID != "p1" || e.EntityID != "e1" || e.Meta["count"] != 3 || e.IP != "203.0.113.9" {
		t.Fatalf("entry = %+v", e)
	}

	if err := s.Record(context.Background(), ptActorWith(""), "system.job", "", "", nil); err != nil {
		t.Fatal(err)
	}
	if st.inserted[1].IP != "" {
		t.Fatalf("no ip expected, got %q", st.inserted[1].IP)
	}
	if err := s.Record(context.Background(), ptActorWith("u"), "", "", "", nil); err == nil {
		t.Fatal("empty action must be rejected")
	}
	st.insErr = errors.New("db down")
	if err := s.Record(context.Background(), ptActorWith("u"), "x", "", "", nil); err == nil || !errors.Is(err, st.insErr) {
		t.Fatalf("store error must be wrapped, got %v", err)
	}
}

func TestClientIPParsing(t *testing.T) {
	cases := map[string]string{
		"203.0.113.9":         "203.0.113.9",
		"203.0.113.9:80":      "203.0.113.9",
		"[2001:db8::1]:443":   "2001:db8::1",
		"2001:db8::1":         "2001:db8::1",
		"::ffff:203.0.113.9":  "203.0.113.9",
		"not an ip":           "",
		"":                    "",
		"'; DROP TABLE x; --": "",
	}
	for in, want := range cases {
		if got := clientIPFrom(WithClientIP(context.Background(), in)); got != want {
			t.Errorf("clientIPFrom(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAuditListPermissionAndPaging(t *testing.T) {
	st := &fakeAuditStore{}
	for i := 10; i >= 1; i-- {
		st.rows = append(st.rows, domain.AuditEntry{ID: int64(i)})
	}
	s := newAudit(st, AuditConfig{})
	admin := ptActorWith("a", domain.PermAuditView)

	_, err := s.List(context.Background(), ptActorWith("w", domain.PermUserView), AuditQuery{})
	mustCode(t, err, domain.CodeForbidden)

	page, err := s.List(context.Background(), admin, AuditQuery{Limit: 4, ProjectID: "p", ActorID: "u", Before: 99})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 4 || page.Next != 7 {
		t.Fatalf("page = %d items, next %d", len(page.Items), page.Next)
	}
	if f := st.listed[0]; f.Limit != 5 || f.ProjectID != "p" || f.ActorID != "u" || f.Before != 99 {
		t.Fatalf("filter = %+v", f)
	}

	last, _ := s.List(context.Background(), admin, AuditQuery{Limit: 10})
	if len(last.Items) != 10 || last.Next != 0 {
		t.Fatalf("last page = %d items, next %d", len(last.Items), last.Next)
	}
	def, _ := s.List(context.Background(), admin, AuditQuery{})
	if st.listed[len(st.listed)-1].Limit != DefaultAuditPageSize+1 || len(def.Items) != 10 {
		t.Fatalf("default limit not applied: %+v", st.listed[len(st.listed)-1])
	}

	for _, q := range []AuditQuery{{Limit: -1}, {Limit: 201}, {Before: -5, Limit: 5}} {
		_, err := s.List(context.Background(), admin, q)
		mustCode(t, err, domain.CodeValidation)
	}
}

func TestAuditRetentionBatches(t *testing.T) {
	st := &fakeAuditStore{old: 12_000, excess: 5000}
	s := newAudit(st, AuditConfig{RetentionDays: 30, MaxRows: 100_000})
	res, err := s.Retention(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.ByAge != 12_000 || res.ByCount != 5000 {
		t.Fatalf("res = %+v", res)
	}
	// 12000 old rows -> batches 5000, 5000, 2000; exactly one full batch of excess then an empty one
	if len(st.ageCalls) != 3 || st.ageCalls[0] != 5000 || st.ageCalls[2] != 2000 {
		t.Fatalf("age batches = %v", st.ageCalls)
	}
	if len(st.maxCall) != 2 || st.maxCall[1] != 0 {
		t.Fatalf("count batches = %v", st.maxCall)
	}
	if want := testNow.Add(-30 * 24 * time.Hour); !st.cutoff.Equal(want) {
		t.Fatalf("cutoff = %v, want %v", st.cutoff, want)
	}
	if st.keep != 100_000 {
		t.Fatalf("keep = %d", st.keep)
	}
}

func TestAuditRetentionDefaultsAndCancel(t *testing.T) {
	st := &fakeAuditStore{}
	s := newAudit(st, AuditConfig{})
	if _, err := s.Retention(context.Background()); err != nil {
		t.Fatal(err)
	}
	if st.keep != domain.DefaultAuditMaxRows || !st.cutoff.Equal(testNow.Add(-30*24*time.Hour)) {
		t.Fatalf("defaults not applied: keep=%d cutoff=%v", st.keep, st.cutoff)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	st2 := &fakeAuditStore{old: 100_000}
	if _, err := newAudit(st2, AuditConfig{}).Retention(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
	if len(st2.ageCalls) != 0 {
		t.Fatal("a cancelled run must not delete")
	}
}
