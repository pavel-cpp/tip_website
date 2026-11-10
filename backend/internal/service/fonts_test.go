package service

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

type fakeFontRepo struct {
	fonts map[string]domain.Font
	used  map[string]bool
}

func newFakeFontRepo() *fakeFontRepo {
	return &fakeFontRepo{fonts: map[string]domain.Font{}, used: map[string]bool{}}
}

func (r *fakeFontRepo) Create(_ context.Context, f domain.Font) error { r.fonts[f.ID] = f; return nil }
func (r *fakeFontRepo) List(context.Context) ([]domain.Font, error) {
	out := []domain.Font{}
	for _, f := range r.fonts {
		out = append(out, f)
	}
	return out, nil
}
func (r *fakeFontRepo) Get(_ context.Context, id string) (domain.Font, error) {
	if f, ok := r.fonts[id]; ok {
		return f, nil
	}
	return domain.Font{}, domain.ErrNotFound
}
func (r *fakeFontRepo) GetBySHA(_ context.Context, sha string) (domain.Font, error) {
	for _, f := range r.fonts {
		if f.SHA256 == sha {
			return f, nil
		}
	}
	return domain.Font{}, domain.ErrNotFound
}
func (r *fakeFontRepo) Delete(_ context.Context, id string) error {
	if _, ok := r.fonts[id]; !ok {
		return domain.ErrNotFound
	}
	delete(r.fonts, id)
	return nil
}
func (r *fakeFontRepo) Usage(context.Context) (int, int64, error) {
	var total int64
	for _, f := range r.fonts {
		total += int64(f.Bytes)
	}
	return len(r.fonts), total, nil
}
func (r *fakeFontRepo) InUse(_ context.Context, id string) (bool, error) { return r.used[id], nil }
func (r *fakeFontRepo) Exists(_ context.Context, id string) (bool, error) {
	_, ok := r.fonts[id]
	return ok, nil
}
func (r *fakeFontRepo) Hashes(context.Context) (map[string]struct{}, error) {
	out := map[string]struct{}{}
	for _, f := range r.fonts {
		out[f.SHA256] = struct{}{}
	}
	return out, nil
}

type fontEnv struct {
	svc   *FontService
	repo  *fakeFontRepo
	blobs *fakeBlobs
	audit *fakeAudit
}

func newFontEnv() *fontEnv {
	e := &fontEnv{repo: newFakeFontRepo(), blobs: &fakeBlobs{files: map[string][]byte{}}, audit: &fakeAudit{}}
	e.svc = NewFontService(FontsDeps{Repo: e.repo, Blobs: e.blobs, Audit: e.audit, Tx: passTx{}, Clock: fixedClock{}, IDs: &seqIDs{}})
	return e
}

// ttf builds a fake TrueType file: valid magic, then filler that makes each salt distinct.
func ttf(salt string, size int) []byte {
	b := append([]byte{0, 1, 0, 0}, []byte(salt)...)
	for len(b) < size {
		b = append(b, 'x')
	}
	return b
}

func TestFontUploadStoresAndAudits(t *testing.T) {
	e := newFontEnv()
	ctx := context.Background()
	f, err := e.svc.Upload(ctx, admin, "  Brand  ", true, ttf("a", 100))
	if err != nil {
		t.Fatal(err)
	}
	if f.Name != "Brand" || f.Format != domain.FontFormatTTF || f.Bytes != 100 || f.CreatedBy != "u1" {
		t.Fatalf("font %+v", f)
	}
	if _, ok := e.blobs.files[f.SHA256]; !ok {
		t.Fatal("blob not stored under its hash")
	}
	if got := e.audit.actions(); len(got) != 1 || got[0] != ActionFontUpload {
		t.Fatalf("audit %v", got)
	}
	if _, ok := e.audit.entries[0].Meta["name"]; ok {
		t.Fatal("audit meta must carry ids and numbers only")
	}

	// The same file again is idempotent: no second row, no second audit entry.
	again, err := e.svc.Upload(ctx, admin, "Other name", true, ttf("a", 100))
	if err != nil || again.ID != f.ID || len(e.repo.fonts) != 1 || len(e.audit.entries) != 1 {
		t.Fatalf("duplicate upload: %+v %v rows=%d audit=%d", again, err, len(e.repo.fonts), len(e.audit.entries))
	}
}

func TestFontUploadRejects(t *testing.T) {
	e := newFontEnv()
	ctx := context.Background()
	tests := []struct {
		name string
		a    domain.Actor
		fn   string
		lic  bool
		data []byte
		want error
	}{
		{"viewer", viewer, "F", true, ttf("a", 50), domain.ErrForbidden},
		{"licence not confirmed", admin, "F", false, ttf("a", 50), domain.ErrValidation},
		{"empty name", admin, "  ", true, ttf("a", 50), domain.ErrValidation},
		{"long name", admin, strings.Repeat("n", 61), true, ttf("a", 50), domain.ErrValidation},
		{"too large", admin, "F", true, ttf("a", domain.MaxFontBytes+1), domain.ErrTooLarge},
		{"not a font", admin, "F", true, []byte("this is plain text, not a font"), domain.ErrUnsupportedMedia},
		{"woff1", admin, "F", true, append([]byte("wOFF"), make([]byte, 20)...), domain.ErrUnsupportedMedia},
	}
	for _, tc := range tests {
		if _, err := e.svc.Upload(ctx, tc.a, tc.fn, tc.lic, tc.data); !errors.Is(err, tc.want) {
			t.Errorf("%s: got %v, want %v", tc.name, err, tc.want)
		}
	}
	if len(e.repo.fonts) != 0 || len(e.blobs.files) != 0 {
		t.Fatal("a rejected upload left data behind")
	}
}

func TestFontUploadQuota(t *testing.T) {
	e := newFontEnv()
	ctx := context.Background()
	// Ten 2 MiB files fill the 20 MiB total; the eleventh must be refused.
	for i := 0; i < domain.MaxFontsTotal/domain.MaxFontBytes; i++ {
		salt := string(rune('a' + i))
		if _, err := e.svc.Upload(ctx, admin, "F", true, ttf(salt, domain.MaxFontBytes)); err != nil {
			t.Fatalf("upload %d: %v", i, err)
		}
	}
	if _, err := e.svc.Upload(ctx, admin, "F", true, ttf("z", 100)); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("over the total cap: %v", err)
	}

	e = newFontEnv()
	for i := 0; i < domain.MaxFontCount; i++ {
		if _, err := e.svc.Upload(ctx, admin, "F", true, ttf(strings.Repeat("s", i+1), 64)); err != nil {
			t.Fatalf("upload %d: %v", i, err)
		}
	}
	if _, err := e.svc.Upload(ctx, admin, "F", true, ttf("over", 64)); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("over the count cap: %v", err)
	}
}

func TestFontDelete(t *testing.T) {
	e := newFontEnv()
	ctx := context.Background()
	f, err := e.svc.Upload(ctx, admin, "F", true, ttf("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Delete(ctx, viewer, f.ID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("viewer delete: %v", err)
	}
	e.repo.used[f.ID] = true
	if err := e.svc.Delete(ctx, admin, f.ID); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("delete of a font in use: %v", err)
	}
	if len(e.repo.fonts) != 1 {
		t.Fatal("font in use was deleted")
	}
	e.repo.used[f.ID] = false
	if err := e.svc.Delete(ctx, admin, f.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.blobs.files[f.SHA256]; ok {
		t.Fatal("blob not removed")
	}
	if got := e.audit.actions(); len(got) != 2 || got[1] != ActionFontDelete {
		t.Fatalf("audit %v", got)
	}
	if err := e.svc.Delete(ctx, admin, f.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
}

func TestFontFileAndList(t *testing.T) {
	e := newFontEnv()
	ctx := context.Background()
	data := ttf("a", 64)
	f, err := e.svc.Upload(ctx, admin, "F", true, data)
	if err != nil {
		t.Fatal(err)
	}
	list, err := e.svc.List(ctx, viewer)
	if err != nil || len(list) != 1 {
		t.Fatalf("list %v %v", list, err)
	}
	if _, err := e.svc.List(ctx, actor()); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("list without permission: %v", err)
	}

	file, err := e.svc.File(ctx, viewer, f.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(file.Body)
	_ = file.Body.Close()
	if string(body) != string(data) || file.ETag() != `"`+f.SHA256+`"` {
		t.Fatal("wrong body or etag")
	}
	nm, err := e.svc.File(ctx, viewer, f.ID, file.ETag())
	if err != nil || !nm.NotModified || nm.Body != nil {
		t.Fatalf("conditional get: %+v %v", nm, err)
	}
	if _, err := e.svc.File(ctx, viewer, "missing", ""); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
}

func TestProjectUpdateChecksCustomFonts(t *testing.T) {
	e := newEnv()
	fonts := newFakeFontRepo()
	e.svc = NewProjectService(ProjectsDeps{
		Repo: e.repo, Blobs: e.blobs, Images: fakeImages{}, Audit: e.audit, Events: e.events,
		Fonts: fonts, Tx: passTx{}, Clock: fixedClock{}, IDs: &seqIDs{},
	})
	ctx := context.Background()
	v := mustCreate(t, e, "P")
	const id = "0198f2f0-7a3c-7c1e-9b57-2f4d5a6b7c8d"
	ph := v.Placeholders.Name
	ph.Font = domain.CustomFontRef(id)

	var ve *domain.ValidationError
	_, err := e.svc.Update(ctx, admin, v.ID, UpdateProjectInput{Placeholders: &PlaceholdersPatch{Name: &ph}, Version: 1})
	if !errors.As(err, &ve) || ve.Fields[0].Field != "placeholders.name.font" {
		t.Fatalf("unknown uploaded font accepted: %v", err)
	}
	fonts.fonts[id] = domain.Font{ID: id, SHA256: strings.Repeat("e", 64)}
	got, err := e.svc.Update(ctx, admin, v.ID, UpdateProjectInput{Placeholders: &PlaceholdersPatch{Name: &ph}, Version: 1})
	if err != nil || got.Placeholders.Name.Font != ph.Font {
		t.Fatalf("existing uploaded font rejected: %v", err)
	}

	// Without a font store only built-in fonts are accepted.
	e2 := newEnv()
	v2 := mustCreate(t, e2, "Q")
	if _, err := e2.svc.Update(ctx, admin, v2.ID, UpdateProjectInput{Placeholders: &PlaceholdersPatch{Name: &ph}, Version: 1}); !errors.As(err, &ve) {
		t.Fatalf("custom font accepted without a store: %v", err)
	}

	// The blob GC must keep font files.
	if _, err := e.svc.CollectGarbage(ctx); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.blobs.gcRefs[strings.Repeat("e", 64)]; !ok {
		t.Fatal("font hash missing from the GC reference set")
	}
}
