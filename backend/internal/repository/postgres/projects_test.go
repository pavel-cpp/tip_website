package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/db"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/dbtest"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/ids"
	"github.com/pavel-cpp/tip_website/backend/migrations"
)

// projectsTestDB returns a migrated pool; the test is skipped when Docker is unavailable.
func projectsTestDB(t *testing.T) *sql.DB {
	t.Helper()
	d, err := sql.Open("pgx", dbtest.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(context.Background(), d, migrations.FS, "."); err != nil {
		t.Fatal(err)
	}
	return d
}

var projectSeq int

func seedUser(t *testing.T, d *sql.DB, name string, avatar bool) string {
	t.Helper()
	projectSeq++
	var id string
	login := fmt.Sprintf("u%d-%d", time.Now().UnixNano()%1_000_000_000, projectSeq)
	err := d.QueryRow(`INSERT INTO users (login, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id::text`,
		login, name).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	if avatar {
		if _, err := d.Exec(`INSERT INTO user_avatars (user_id, mime, data, sha256) VALUES ($1, 'image/jpeg', '\x00', 'avsha')`, id); err != nil {
			t.Fatal(err)
		}
	}
	return id
}

func newProject(title, createdBy string) domain.Project {
	now := time.Now().UTC().Truncate(time.Microsecond)
	return domain.Project{
		ID: newUUID(), Title: title, Status: domain.ProjectActive,
		Placeholders: domain.DefaultPlaceholders(0, 0), NextNumber: 1, Version: 1,
		CreatedBy: createdBy, CreatedAt: now, UpdatedAt: now,
	}
}

func newUUID() string { return ids.UUIDv7{}.NewID() }

func TestProjectRepoLifecycle(t *testing.T) {
	d := projectsTestDB(t)
	r := NewProjectRepo(d)
	ctx := context.Background()
	user := seedUser(t, d, "Alice", false)

	p := newProject("Giveaway", user)
	if err := r.Create(ctx, p); err != nil {
		t.Fatal(err)
	}
	got, err := r.Get(ctx, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Giveaway" || got.Version != 1 || got.Status != domain.ProjectActive || got.CreatedBy != user ||
		got.Image != nil || got.FinishedAt != nil || got.Placeholders != p.Placeholders {
		t.Fatalf("round trip mismatch: %+v", got)
	}

	// Image + placeholders + title via Save with version bump.
	got.Title = "Renamed"
	got.Image = &domain.ImageMeta{SHA256: hex64('a'), Name: "t.png", Mime: "image/png", Width: 800, Height: 600, Bytes: 1234}
	got.Placeholders.Name.X = 123
	got.Placeholders.Phone.Bold = !got.Placeholders.Phone.Bold
	got.Version++
	got.UpdatedAt = time.Now().UTC().Truncate(time.Microsecond)
	if err := r.Save(ctx, got, 1); err != nil {
		t.Fatal(err)
	}
	again, err := r.Get(ctx, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if again.Title != "Renamed" || again.Version != 2 || again.Placeholders != got.Placeholders ||
		again.Image == nil || *again.Image != *got.Image {
		t.Fatalf("after save: %+v", again)
	}

	// Stale version.
	got.Version++
	if err := r.Save(ctx, got, 1); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("stale save: %v", err)
	}
	ghost := got
	ghost.ID = newUUID()
	if err := r.Save(ctx, ghost, 1); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("missing save: %v", err)
	}

	// Finish and reopen through Save.
	fin, err := again.Finish(time.Now().UTC().Truncate(time.Microsecond))
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Save(ctx, fin, again.Version); err != nil {
		t.Fatal(err)
	}
	if g, _ := r.Get(ctx, p.ID); g.Status != domain.ProjectFinished || g.FinishedAt == nil {
		t.Fatalf("finish not stored: %+v", g)
	}

	if n, _ := r.CountImageRefs(ctx, hex64('a')); n != 1 {
		t.Fatalf("refs = %d", n)
	}
	refs, err := r.ReferencedImageHashes(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := refs[hex64('a')]; !ok {
		t.Fatal("hash missing from referenced set")
	}

	if err := r.Delete(ctx, p.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Get(ctx, p.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("after delete: %v", err)
	}
	if err := r.Delete(ctx, p.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
	if n, _ := r.CountImageRefs(ctx, hex64('a')); n != 0 {
		t.Fatalf("refs after delete = %d", n)
	}
	if _, err := r.GetForUpdate(ctx, p.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("GetForUpdate: %v", err)
	}
}

func hex64(c byte) string {
	b := make([]byte, 64)
	for i := range b {
		b[i] = c
	}
	return string(b)
}

func TestProjectRepoListFilters(t *testing.T) {
	d := projectsTestDB(t)
	r := NewProjectRepo(d)
	ctx := context.Background()
	tag := fmt.Sprintf("zq%d", time.Now().UnixNano())

	mk := func(title string, finished bool) domain.Project {
		p := newProject(title, "")
		if err := r.Create(ctx, p); err != nil {
			t.Fatal(err)
		}
		if finished {
			f, _ := p.Finish(p.CreatedAt)
			if err := r.Save(ctx, f, 1); err != nil {
				t.Fatal(err)
			}
		}
		return p
	}
	a := mk(tag+" Alpha", false)
	b := mk(tag+" beta 100%", true)
	c := mk(tag+" gamma_x", false)

	ids := func(f domain.ProjectFilter) []string {
		ps, err := r.List(ctx, f)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, p := range ps {
			out = append(out, p.ID)
		}
		return out
	}
	fin, act := domain.ProjectFinished, domain.ProjectActive
	all := ids(domain.ProjectFilter{Query: tag})
	if len(all) != 3 {
		t.Fatalf("all = %v", all)
	}
	if got := ids(domain.ProjectFilter{Query: tag, Status: &fin}); !slices.Equal(got, []string{b.ID}) {
		t.Fatalf("finished = %v", got)
	}
	if got := ids(domain.ProjectFilter{Query: tag, Status: &act}); len(got) != 2 {
		t.Fatalf("active = %v", got)
	}
	if got := ids(domain.ProjectFilter{Query: tag + " ALPHA"}); !slices.Equal(got, []string{a.ID}) {
		t.Fatalf("case-insensitive = %v", got)
	}
	// Wildcards in user input are literal.
	if got := ids(domain.ProjectFilter{Query: tag + " beta 100%"}); !slices.Equal(got, []string{b.ID}) {
		t.Fatalf("percent = %v", got)
	}
	if got := ids(domain.ProjectFilter{Query: tag + " %"}); len(got) != 0 {
		t.Fatalf("lone percent matched %v", got)
	}
	if got := ids(domain.ProjectFilter{Query: tag + " gamma_"}); !slices.Equal(got, []string{c.ID}) {
		t.Fatalf("underscore = %v", got)
	}
	if got := ids(domain.ProjectFilter{Query: tag + " gammaX"}); len(got) != 0 {
		t.Fatalf("underscore acted as wildcard: %v", got)
	}
}

func TestProjectRepoDetailsAndContributors(t *testing.T) {
	d := projectsTestDB(t)
	r := NewProjectRepo(d)
	ctx := context.Background()
	u1 := seedUser(t, d, "Alice", true)
	u2 := seedUser(t, d, "Bob", false)
	p := newProject("P", u1)
	empty := newProject("E", "")
	for _, x := range []domain.Project{p, empty} {
		if err := r.Create(ctx, x); err != nil {
			t.Fatal(err)
		}
	}

	t0 := time.Now().UTC().Truncate(time.Microsecond)
	if err := r.TouchContributor(ctx, p.ID, u1, t0); err != nil {
		t.Fatal(err)
	}
	if err := r.TouchContributor(ctx, p.ID, u2, t0.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	// Upsert: u1 becomes the most recent and keeps a single row.
	if err := r.TouchContributor(ctx, p.ID, u1, t0.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := r.TouchContributor(ctx, p.ID, "", t0); err != nil {
		t.Fatalf("empty user must be a no-op: %v", err)
	}
	var n int
	_ = d.QueryRow(`SELECT count(*) FROM project_contributors WHERE project_id = $1`, p.ID).Scan(&n)
	if n != 2 {
		t.Fatalf("contributor rows = %d", n)
	}
	for i := 0; i < 3; i++ {
		if _, err := d.Exec(`INSERT INTO participants (project_id, number) VALUES ($1, $2)`, p.ID, i+1); err != nil {
			t.Fatal(err)
		}
	}

	det, err := r.Details(ctx, []string{p.ID, empty.ID}, 10)
	if err != nil {
		t.Fatal(err)
	}
	got := det[p.ID]
	if got.ParticipantCount != 3 || len(got.Contributors) != 2 {
		t.Fatalf("details %+v", got)
	}
	if got.Contributors[0].ID != u1 || got.Contributors[0].AvatarSHA != "avsha" || got.Contributors[1].ID != u2 || got.Contributors[1].AvatarSHA != "" {
		t.Fatalf("contributors %+v", got.Contributors)
	}
	if e, ok := det[empty.ID]; !ok || e.ParticipantCount != 0 || len(e.Contributors) != 0 {
		t.Fatalf("empty details %+v", e)
	}
	limited, _ := r.Details(ctx, []string{p.ID}, 1)
	if len(limited[p.ID].Contributors) != 1 || limited[p.ID].Contributors[0].ID != u1 {
		t.Fatalf("limit not applied: %+v", limited[p.ID])
	}

	// Deleting the project cascades.
	if err := r.Delete(ctx, p.ID); err != nil {
		t.Fatal(err)
	}
	_ = d.QueryRow(`SELECT count(*) FROM project_contributors WHERE project_id = $1`, p.ID).Scan(&n)
	if n != 0 {
		t.Fatal("contributors not cascaded")
	}
}

func TestProjectRepoJoinsTransaction(t *testing.T) {
	d := projectsTestDB(t)
	r := NewProjectRepo(d)
	m := NewTxManager(d)
	p := newProject("Rolled back", "")
	err := m.Do(context.Background(), func(ctx context.Context) error {
		if err := r.Create(ctx, p); err != nil {
			return err
		}
		if _, err := r.GetForUpdate(ctx, p.ID); err != nil {
			return err
		}
		return errors.New("boom")
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if _, err := r.Get(context.Background(), p.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("project survived rollback: %v", err)
	}
}
