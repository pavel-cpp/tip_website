package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

func newFont(name, shaChar string, bytes int, createdBy string) domain.Font {
	return domain.Font{
		ID: newUUID(), Name: name, Format: domain.FontFormatTTF, SHA256: strings.Repeat(shaChar, 64),
		Bytes: bytes, CreatedBy: createdBy, CreatedAt: time.Now().UTC().Truncate(time.Microsecond),
	}
}

func TestFontRepo(t *testing.T) {
	d := projectsTestDB(t)
	fonts := NewFontRepo(d)
	projects := NewProjectRepo(d)
	ctx := context.Background()
	user := seedUser(t, d, "Font Owner", false)

	n0, b0, err := fonts.Usage(ctx)
	if err != nil {
		t.Fatal(err)
	}

	f := newFont("Brand Sans", "c", 1000, user)
	if err := fonts.Create(ctx, f); err != nil {
		t.Fatal(err)
	}
	got, err := fonts.Get(ctx, f.ID)
	if err != nil || !got.CreatedAt.Equal(f.CreatedAt) {
		t.Fatalf("created_at = %v, %v; want %v", got.CreatedAt, err, f.CreatedAt)
	}
	got.CreatedAt = f.CreatedAt
	if got != f {
		t.Fatalf("get = %+v, %v; want %+v", got, err, f)
	}
	bySHA, err := fonts.GetBySHA(ctx, f.SHA256)
	if err != nil || bySHA.ID != f.ID {
		t.Fatalf("get by sha = %+v, %v", bySHA, err)
	}
	if _, err := fonts.Get(ctx, newUUID()); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("missing font: %v", err)
	}
	if _, err := fonts.GetBySHA(ctx, strings.Repeat("d", 64)); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("missing sha: %v", err)
	}
	if err := fonts.Create(ctx, newFont("Dup", "c", 5, "")); err == nil {
		t.Fatal("duplicate content hash accepted")
	}

	n, b, err := fonts.Usage(ctx)
	if err != nil || n != n0+1 || b != b0+1000 {
		t.Fatalf("usage = %d, %d, %v", n, b, err)
	}
	list, err := fonts.List(ctx)
	if err != nil || len(list) != n0+1 || list[0].ID != f.ID {
		t.Fatalf("list = %+v, %v", list, err)
	}
	if ok, err := fonts.Exists(ctx, f.ID); err != nil || !ok {
		t.Fatalf("exists = %v, %v", ok, err)
	}
	if hs, err := fonts.Hashes(ctx); err != nil {
		t.Fatal(err)
	} else if _, ok := hs[f.SHA256]; !ok {
		t.Fatal("hash missing from Hashes")
	}

	// A placeholder that selects the font blocks its deletion check (InUse).
	if used, err := fonts.InUse(ctx, f.ID); err != nil || used {
		t.Fatalf("in use before = %v, %v", used, err)
	}
	p := newProject("Uses font", user)
	p.Placeholders.Name.Font = domain.CustomFontRef(f.ID)
	if err := projects.Create(ctx, p); err != nil {
		t.Fatal(err)
	}
	if used, err := fonts.InUse(ctx, f.ID); err != nil || !used {
		t.Fatalf("in use after = %v, %v", used, err)
	}

	if err := fonts.Delete(ctx, f.ID); err != nil {
		t.Fatal(err)
	}
	if err := fonts.Delete(ctx, f.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
	if ok, _ := fonts.Exists(ctx, f.ID); ok {
		t.Fatal("font still exists")
	}
}
