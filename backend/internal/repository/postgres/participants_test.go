package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

func ptSeedUser(t *testing.T, d *sql.DB, login string) string {
	t.Helper()
	var id string
	err := d.QueryRowContext(context.Background(),
		`INSERT INTO users (login, display_name, password_hash) VALUES ($1, $1, 'x') RETURNING id::text`, login).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func seedProject(t *testing.T, d *sql.DB, status string) string {
	t.Helper()
	var id string
	err := d.QueryRowContext(context.Background(),
		`INSERT INTO projects (title, status) VALUES ('Raffle', $1::project_status) RETURNING id::text`, status).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func numbers(rows []domain.Participant) []int {
	out := make([]int, len(rows))
	for i, r := range rows {
		out[i] = r.Number
	}
	return out
}

func TestParticipantRepoAddAndList(t *testing.T) {
	d := newMigratedDB(t)
	r := NewParticipantRepo(d)
	ctx := context.Background()
	user := ptSeedUser(t, d, "op.one")
	proj := seedProject(t, d, "active")
	now := time.Now().UTC().Truncate(time.Microsecond)

	empty, err := r.AddEmpty(ctx, proj, 3, user, now)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(numbers(empty)) != "[1 2 3]" {
		t.Fatalf("numbers = %v", numbers(empty))
	}
	if empty[0].Version != 1 || empty[0].UpdatedBy != user || !empty[0].UpdatedAt.Equal(now) || empty[0].ProjectID != proj {
		t.Fatalf("unexpected row: %+v", empty[0])
	}

	items, err := r.Add(ctx, proj, []domain.Participant{{Name: "Azam", Phone: "+998"}, {Name: "Ali"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(numbers(items)) != "[4 5]" || items[0].Name != "Azam" || items[0].Phone != "+998" || items[1].Phone != "" {
		t.Fatalf("items = %+v", items)
	}
	if items[0].UpdatedBy != "" {
		t.Fatalf("updated_by should be empty, got %q", items[0].UpdatedBy)
	}

	all, err := r.List(ctx, proj, "")
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(numbers(all)) != "[1 2 3 4 5]" {
		t.Fatalf("list numbers = %v", numbers(all))
	}
	var next int
	if err := d.QueryRowContext(ctx, `SELECT next_number FROM projects WHERE id = $1`, proj).Scan(&next); err != nil || next != 6 {
		t.Fatalf("next_number = %d, %v", next, err)
	}
	if n, err := r.Count(ctx, proj); err != nil || n != 5 {
		t.Fatalf("count = %d, %v", n, err)
	}
}

func TestParticipantRepoAddProjectErrors(t *testing.T) {
	d := newMigratedDB(t)
	r := NewParticipantRepo(d)
	ctx := context.Background()
	finished := seedProject(t, d, "finished")

	if _, err := r.AddEmpty(ctx, finished, 2, "", time.Now()); !errors.Is(err, domain.ErrProjectFinished) {
		t.Fatalf("finished: got %v", err)
	}
	if n, _ := r.Count(ctx, finished); n != 0 {
		t.Fatalf("rows written into a finished project: %d", n)
	}
	var next int
	if err := d.QueryRowContext(ctx, `SELECT next_number FROM projects WHERE id = $1`, finished).Scan(&next); err != nil || next != 1 {
		t.Fatalf("counter advanced for a finished project: %d, %v", next, err)
	}
	if _, err := r.AddEmpty(ctx, "00000000-0000-7000-8000-000000000000", 1, "", time.Now()); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("missing: got %v", err)
	}
	if rows, err := r.Add(ctx, finished, nil, "", time.Now()); err != nil || rows != nil {
		t.Fatalf("empty add: %v %v", rows, err)
	}
}

func TestParticipantRepoConcurrentAddsGetDistinctNumbers(t *testing.T) {
	d := newMigratedDB(t)
	r := NewParticipantRepo(d)
	ctx := context.Background()
	proj := seedProject(t, d, "active")

	const workers, each = 8, 25
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := r.AddEmpty(ctx, proj, each, "", time.Now())
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	all, err := r.List(ctx, proj, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != workers*each {
		t.Fatalf("rows = %d", len(all))
	}
	for i, p := range all {
		if p.Number != i+1 {
			t.Fatalf("gap or duplicate at index %d: number %d", i, p.Number)
		}
	}
}

func TestParticipantRepoAddIsAtomicInTransaction(t *testing.T) {
	d := newMigratedDB(t)
	r := NewParticipantRepo(d)
	m := NewTxManager(d)
	ctx := context.Background()
	proj := seedProject(t, d, "active")

	boom := errors.New("boom")
	err := m.Do(ctx, func(ctx context.Context) error {
		if _, err := r.AddEmpty(ctx, proj, 4, "", time.Now()); err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatal(err)
	}
	if n, _ := r.Count(ctx, proj); n != 0 {
		t.Fatalf("rows survived the rollback: %d", n)
	}
	var next int
	if err := d.QueryRowContext(ctx, `SELECT next_number FROM projects WHERE id = $1`, proj).Scan(&next); err != nil || next != 1 {
		t.Fatalf("counter survived the rollback: %d, %v", next, err)
	}
}

func TestParticipantRepoUpdateIfVersion(t *testing.T) {
	d := newMigratedDB(t)
	r := NewParticipantRepo(d)
	ctx := context.Background()
	user := ptSeedUser(t, d, "op.two")
	proj := seedProject(t, d, "active")
	rows, err := r.AddEmpty(ctx, proj, 1, "", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	cur := rows[0]

	next, err := cur.Edited("Azam", "+998", cur.Version, user, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	saved, err := r.UpdateIfVersion(ctx, next)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Version != 2 || saved.Name != "Azam" || saved.Phone != "+998" || saved.UpdatedBy != user || saved.Number != cur.Number {
		t.Fatalf("saved = %+v", saved)
	}

	// The same stale edit again must conflict.
	if _, err := r.UpdateIfVersion(ctx, next); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("stale update: got %v", err)
	}
	got, err := r.Get(ctx, cur.ID)
	if err != nil || got.Version != 2 {
		t.Fatalf("get = %+v, %v", got, err)
	}
	if _, err := r.Get(ctx, "00000000-0000-7000-8000-000000000000"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("missing get: %v", err)
	}
}

func TestParticipantRepoConcurrentUpdateOneWins(t *testing.T) {
	d := newMigratedDB(t)
	r := NewParticipantRepo(d)
	ctx := context.Background()
	proj := seedProject(t, d, "active")
	rows, _ := r.AddEmpty(ctx, proj, 1, "", time.Now())
	cur := rows[0]

	const racers = 6
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins, conflicts := 0, 0
	for i := range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			next, _ := cur.Edited(fmt.Sprintf("n%d", i), "", cur.Version, "", time.Now())
			_, err := r.UpdateIfVersion(ctx, next)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				wins++
			case errors.Is(err, domain.ErrVersionConflict):
				conflicts++
			default:
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if wins != 1 || conflicts != racers-1 {
		t.Fatalf("wins=%d conflicts=%d", wins, conflicts)
	}
}

func TestParticipantRepoUpdateManyAndClear(t *testing.T) {
	d := newMigratedDB(t)
	r := NewParticipantRepo(d)
	ctx := context.Background()
	a, b := seedProject(t, d, "active"), seedProject(t, d, "active")
	rowsA, _ := r.AddEmpty(ctx, a, 3, "", time.Now())
	rowsB, _ := r.AddEmpty(ctx, b, 1, "", time.Now())

	// stale versions and rows of another project are left out; unset fields keep their value
	got, err := r.UpdateMany(ctx, a, []domain.ParticipantChange{
		{ID: rowsA[0].ID, SetName: true, Name: "Azam", Version: 1},
		{ID: rowsA[1].ID, SetPhone: true, Phone: "+1", Version: 1},
		{ID: rowsA[2].ID, SetName: true, Name: "stale", Version: 7},
		{ID: rowsB[0].ID, SetName: true, Name: "foreign", Version: 1},
	}, "", time.Now())
	if err != nil || len(got) != 2 || got[0].Name != "Azam" || got[0].Version != 2 || got[1].Phone != "+1" || got[1].Name != "" {
		t.Fatalf("update many = %+v, %v", got, err)
	}
	if byIDs, _ := r.ListByIDs(ctx, a, []string{rowsA[2].ID, rowsB[0].ID, rowsA[0].ID}); len(byIDs) != 2 || byIDs[0].Number != 1 {
		t.Fatalf("list by ids = %+v", byIDs)
	}

	// clear keeps rows and numbers, skips empty rows and other projects
	cleared, err := r.ClearByIDs(ctx, a, []string{rowsA[0].ID, rowsA[2].ID, rowsB[0].ID}, "", time.Now())
	if err != nil || len(cleared) != 1 || cleared[0].Name != "" || cleared[0].Number != 1 || cleared[0].Version != 3 {
		t.Fatalf("clear = %+v, %v", cleared, err)
	}
	if n, _ := r.Count(ctx, a); n != 3 {
		t.Fatalf("rows were removed: %d", n)
	}
	if none, err := r.ClearByIDs(ctx, a, nil, "", time.Now()); err != nil || none != nil {
		t.Fatalf("empty clear: %v %v", none, err)
	}
}

func TestParticipantRepoFilterAndStamp(t *testing.T) {
	d := newMigratedDB(t)
	r := NewParticipantRepo(d)
	ctx := context.Background()
	proj := seedProject(t, d, "active")
	_, err := r.Add(ctx, proj, []domain.Participant{
		{Name: "Azam Tursunov", Phone: "+998 90 111"},
		{Name: "100% Fan", Phone: "+7 926"},
		{Name: "under_score", Phone: ""},
		{Name: "Other", Phone: "+998 91 222"},
	}, "", time.Now())
	if err != nil {
		t.Fatal(err)
	}

	cases := map[string]int{
		"":        4,
		"azam":    1, // case-insensitive
		"+998":    2,
		"100%":    1, // % is literal
		"%":       1,
		"_":       1, // _ is literal
		"4":       1, // exact number match
		"missing": 0,
	}
	for q, want := range cases {
		rows, err := r.List(ctx, proj, q)
		if err != nil {
			t.Fatalf("q=%q: %v", q, err)
		}
		if len(rows) != want {
			t.Errorf("q=%q: %d rows, want %d", q, len(rows), want)
		}
		count, _, _, err := r.Stamp(ctx, proj, q)
		if err != nil || count != want {
			t.Errorf("stamp q=%q: count=%d err=%v", q, count, err)
		}
	}

	c0, v0, w0, err := r.Stamp(ctx, proj, "")
	if err != nil {
		t.Fatal(err)
	}
	rows, _ := r.List(ctx, proj, "")
	next, _ := rows[0].Edited("Changed", "", rows[0].Version, "", time.Now().Add(time.Second))
	if _, err := r.UpdateIfVersion(ctx, next); err != nil {
		t.Fatal(err)
	}
	c1, v1, w1, _ := r.Stamp(ctx, proj, "")
	if c1 != c0 || v1 != v0+1 || !w1.After(w0) {
		t.Fatalf("stamp did not move on edit: (%d,%d,%v) -> (%d,%d,%v)", c0, v0, w0, c1, v1, w1)
	}
	if _, err := r.AddEmpty(ctx, proj, 1, "", time.Now().Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	c2, v2, _, _ := r.Stamp(ctx, proj, "")
	if c2 != c1+1 || v2 <= v1 {
		t.Fatalf("stamp did not move on insert: (%d,%d) -> (%d,%d)", c1, v1, c2, v2)
	}

	empty := seedProject(t, d, "active")
	c, v, w, err := r.Stamp(ctx, empty, "")
	if err != nil || c != 0 || v != 0 || w.Unix() != 0 {
		t.Fatalf("empty stamp = %d %d %v %v", c, v, w, err)
	}
}
