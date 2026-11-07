package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

func TestAuditRepoInsertAndList(t *testing.T) {
	d := newMigratedDB(t)
	r := NewAuditRepo(d)
	ctx := context.Background()
	u1, u2 := seedUser(t, d, "admin.one"), seedUser(t, d, "admin.two")
	p1, p2 := seedProject(t, d, "active"), seedProject(t, d, "active")

	entries := []domain.AuditEntry{
		{ActorID: u1, Action: "tickets.print", ProjectID: p1, Meta: map[string]any{"count": 3}, IP: "203.0.113.7"},
		{ActorID: u2, Action: "participants.clear", ProjectID: p1, Meta: map[string]any{"count": 10}},
		{ActorID: u1, Action: "project.finish", ProjectID: p2, EntityID: p2},
		{ActorID: "", Action: "system.job"},
	}
	for _, e := range entries {
		if err := r.Insert(ctx, e); err != nil {
			t.Fatal(err)
		}
	}

	all, err := r.List(ctx, domain.AuditFilter{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 4 || all[0].Action != "system.job" || all[3].Action != "tickets.print" {
		t.Fatalf("order wrong: %+v", all)
	}
	first := all[3]
	if first.ActorLogin != "admin.one" || first.ActorID != u1 || first.ProjectID != p1 || first.IP != "203.0.113.7" || first.At.IsZero() {
		t.Fatalf("first = %+v", first)
	}
	if v, ok := first.Meta["count"].(float64); !ok || v != 3 {
		t.Fatalf("meta = %+v", first.Meta)
	}
	if all[0].ActorID != "" || all[0].ActorLogin != "" || all[0].Meta == nil {
		t.Fatalf("system entry = %+v", all[0])
	}

	byProject, _ := r.List(ctx, domain.AuditFilter{ProjectID: p1, Limit: 10})
	if len(byProject) != 2 {
		t.Fatalf("by project = %d", len(byProject))
	}
	byActor, _ := r.List(ctx, domain.AuditFilter{ActorID: u1, Limit: 10})
	if len(byActor) != 2 {
		t.Fatalf("by actor = %d", len(byActor))
	}
	both, _ := r.List(ctx, domain.AuditFilter{ActorID: u1, ProjectID: p2, Limit: 10})
	if len(both) != 1 || both[0].EntityID != p2 {
		t.Fatalf("both = %+v", both)
	}

	// cursor paging: two entries per page, no overlap, no gaps
	page1, _ := r.List(ctx, domain.AuditFilter{Limit: 2})
	page2, _ := r.List(ctx, domain.AuditFilter{Limit: 2, Before: page1[1].ID})
	if len(page1) != 2 || len(page2) != 2 || page2[0].ID >= page1[1].ID || page2[1].Action != "tickets.print" {
		t.Fatalf("pages: %+v / %+v", page1, page2)
	}
}

func TestAuditRepoKeepsEntriesWhenActorIsDeleted(t *testing.T) {
	d := newMigratedDB(t)
	r := NewAuditRepo(d)
	ctx := context.Background()
	u := seedUser(t, d, "gone.soon")
	if err := r.Insert(ctx, domain.AuditEntry{ActorID: u, Action: "x"}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ExecContext(ctx, `DELETE FROM users WHERE id = $1`, u); err != nil {
		t.Fatal(err)
	}
	got, _ := r.List(ctx, domain.AuditFilter{Limit: 5})
	if len(got) != 1 || got[0].ActorID != "" || got[0].ActorLogin != "gone.soon" {
		t.Fatalf("got %+v", got)
	}
}

func TestAuditRepoInsertWithUnknownActor(t *testing.T) {
	d := newMigratedDB(t)
	r := NewAuditRepo(d)
	ctx := context.Background()
	if err := r.Insert(ctx, domain.AuditEntry{ActorID: "00000000-0000-7000-8000-000000000000", Action: "x"}); err != nil {
		t.Fatal(err)
	}
	got, _ := r.List(ctx, domain.AuditFilter{Limit: 5})
	if len(got) != 1 || got[0].ActorID != "" {
		t.Fatalf("got %+v", got)
	}
}

func TestAuditRepoRetention(t *testing.T) {
	d := newMigratedDB(t)
	r := NewAuditRepo(d)
	ctx := context.Background()
	// 12 rows, ids ascending; the 5 oldest are 40 days old.
	if _, err := d.ExecContext(ctx, `
		INSERT INTO audit_log (at, actor_login, action)
		SELECT now() - CASE WHEN g <= 5 THEN interval '40 days' ELSE interval '1 day' END, '', 'a'
		FROM generate_series(1, 12) g`); err != nil {
		t.Fatal(err)
	}
	count := func() int {
		var n int
		if err := d.QueryRowContext(ctx, `SELECT count(*) FROM audit_log`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	cutoff := time.Now().Add(-30 * 24 * time.Hour)
	n, err := r.DeleteOlderThan(ctx, cutoff, 3)
	if err != nil || n != 3 || count() != 9 {
		t.Fatalf("first batch: n=%d err=%v count=%d", n, err, count())
	}
	n, _ = r.DeleteOlderThan(ctx, cutoff, 3)
	if n != 2 || count() != 7 {
		t.Fatalf("second batch: n=%d count=%d", n, count())
	}
	n, _ = r.DeleteOlderThan(ctx, cutoff, 3)
	if n != 0 {
		t.Fatalf("nothing should be left to delete, got %d", n)
	}

	// keep the newest 4 of the remaining 7, in batches of 2
	n, err = r.DeleteBeyondMax(ctx, 4, 2)
	if err != nil || n != 2 || count() != 5 {
		t.Fatalf("max batch 1: n=%d err=%v count=%d", n, err, count())
	}
	n, _ = r.DeleteBeyondMax(ctx, 4, 2)
	if n != 1 || count() != 4 {
		t.Fatalf("max batch 2: n=%d count=%d", n, count())
	}
	n, _ = r.DeleteBeyondMax(ctx, 4, 2)
	if n != 0 || count() != 4 {
		t.Fatalf("max batch 3: n=%d count=%d", n, count())
	}
	// the survivors are the newest ones
	var minID, maxID int64
	_ = d.QueryRowContext(ctx, `SELECT min(id), max(id) FROM audit_log`).Scan(&minID, &maxID)
	if maxID-minID != 3 {
		t.Fatalf("survivors are not the newest contiguous ids: %d..%d", minID, maxID)
	}
	// keeping more than exist deletes nothing
	if n, _ := r.DeleteBeyondMax(ctx, 100, 10); n != 0 {
		t.Fatalf("deleted %d with a large keep", n)
	}
}
