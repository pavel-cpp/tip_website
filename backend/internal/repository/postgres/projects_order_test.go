package postgres

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

func listIDs(t *testing.T, r *ProjectRepo) []string {
	t.Helper()
	ps, err := r.List(context.Background(), domain.ProjectFilter{})
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = p.ID
	}
	return out
}

func TestProjectRepoOrder(t *testing.T) {
	d := projectsTestDB(t)
	r := NewProjectRepo(d)
	ctx := context.Background()
	if _, err := d.Exec(`DELETE FROM projects`); err != nil {
		t.Fatal(err)
	}
	var made []domain.Project
	for _, title := range []string{"A", "B", "C", "D"} {
		p := newProject(title, "")
		if err := r.Create(ctx, p); err != nil {
			t.Fatal(err)
		}
		made = append(made, p)
	}
	a, b, c, dd := made[0].ID, made[1].ID, made[2].ID, made[3].ID
	// New projects go first.
	if got := listIDs(t, r); !slices.Equal(got, []string{dd, c, b, a}) {
		t.Fatalf("default order = %v", got)
	}

	// A subset (with an unknown and a repeated id) takes over its own slots; the rest stay put.
	if err := r.Reorder(ctx, []string{a, newUUID(), dd, a}, false); err != nil {
		t.Fatal(err)
	}
	if got := listIDs(t, r); !slices.Equal(got, []string{a, c, b, dd}) {
		t.Fatalf("after subset reorder = %v", got)
	}

	// A finished project is skipped for callers who cannot see finished ones: it keeps its slot.
	fin, err := r.Get(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	fin, err = fin.Finish(time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Save(ctx, fin, fin.Version-1); err != nil {
		t.Fatal(err)
	}
	if err := r.Reorder(ctx, []string{dd, c, b, a}, true); err != nil {
		t.Fatal(err)
	}
	if got := listIDs(t, r); !slices.Equal(got, []string{dd, c, b, a}) {
		t.Fatalf("after active-only reorder = %v", got)
	}
}
