package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// --- fakes ---

type fakeRepo struct {
	projects map[string]domain.Project
	touched  []string
	details  map[string]domain.ProjectDetails
	saveErr  error

	reorderIDs        []string
	reorderActiveOnly bool
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{projects: map[string]domain.Project{}, details: map[string]domain.ProjectDetails{}}
}

func (r *fakeRepo) Create(_ context.Context, p domain.Project) error {
	r.projects[p.ID] = p
	return nil
}
func (r *fakeRepo) Get(_ context.Context, id string) (domain.Project, error) {
	p, ok := r.projects[id]
	if !ok {
		return domain.Project{}, domain.ErrNotFound
	}
	return p, nil
}
func (r *fakeRepo) GetForUpdate(ctx context.Context, id string) (domain.Project, error) {
	return r.Get(ctx, id)
}
func (r *fakeRepo) Save(_ context.Context, p domain.Project, expected int) error {
	if r.saveErr != nil {
		return r.saveErr
	}
	if r.projects[p.ID].Version != expected {
		return domain.ErrVersionConflict
	}
	r.projects[p.ID] = p
	return nil
}
func (r *fakeRepo) Delete(_ context.Context, id string) error {
	if _, ok := r.projects[id]; !ok {
		return domain.ErrNotFound
	}
	delete(r.projects, id)
	return nil
}
func (r *fakeRepo) List(_ context.Context, f domain.ProjectFilter) ([]domain.Project, error) {
	var out []domain.Project
	for _, p := range r.projects {
		if f.Status != nil && p.Status != *f.Status {
			continue
		}
		if f.Query != "" && !strings.Contains(strings.ToLower(p.Title), strings.ToLower(f.Query)) {
			continue
		}
		out = append(out, p)
	}
	slices.SortFunc(out, func(a, b domain.Project) int { return strings.Compare(a.ID, b.ID) })
	return out, nil
}
func (r *fakeRepo) Details(_ context.Context, ids []string, _ int) (map[string]domain.ProjectDetails, error) {
	out := map[string]domain.ProjectDetails{}
	for _, id := range ids {
		out[id] = r.details[id]
	}
	return out, nil
}
func (r *fakeRepo) TouchContributor(_ context.Context, projectID, userID string, _ time.Time) error {
	r.touched = append(r.touched, projectID+"/"+userID)
	return nil
}
func (r *fakeRepo) CountImageRefs(_ context.Context, sha string) (int, error) {
	n := 0
	for _, p := range r.projects {
		if p.Image != nil && p.Image.SHA256 == sha {
			n++
		}
	}
	return n, nil
}
func (r *fakeRepo) ReferencedImageHashes(_ context.Context) (map[string]struct{}, error) {
	out := map[string]struct{}{}
	for _, p := range r.projects {
		if p.Image != nil {
			out[p.Image.SHA256] = struct{}{}
		}
	}
	return out, nil
}

type fakeBlobs struct {
	files   map[string][]byte
	full    bool
	gcCalls int
	gcRefs  map[string]struct{}
}

func (b *fakeBlobs) Put(_ context.Context, sha string, data []byte) error {
	if b.full {
		return domain.ErrDiskLow
	}
	b.files[sha] = data
	return nil
}

type nopSeekCloser struct{ *bytes.Reader }

func (nopSeekCloser) Close() error { return nil }

func (b *fakeBlobs) Open(_ context.Context, sha string) (io.ReadSeekCloser, error) {
	d, ok := b.files[sha]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return nopSeekCloser{bytes.NewReader(d)}, nil
}
func (b *fakeBlobs) Delete(_ context.Context, sha string) error { delete(b.files, sha); return nil }
func (b *fakeBlobs) GC(_ context.Context, refs map[string]struct{}) (int, error) {
	b.gcCalls++
	b.gcRefs = refs
	return 0, nil
}

// fakeImages returns the input unchanged; the dimensions come from a "WxH:" prefix.
type fakeImages struct{}

func (fakeImages) Normalize(data []byte) ([]byte, string, int, int, error) {
	var w, h int
	if _, err := fmt.Sscanf(string(data), "%dx%d:", &w, &h); err != nil {
		return nil, "", 0, 0, domain.ErrImageInvalid
	}
	return data, "image/png", w, h, nil
}

// Thumbnail derives a preview whose content is recognizable in assertions.
func (fakeImages) Thumbnail(data []byte) ([]byte, error) {
	return append([]byte("thumb:"), data...), nil
}

type fakeAudit struct {
	entries []ProjectAuditEntry
	err     error
}

func (a *fakeAudit) Record(_ context.Context, e ProjectAuditEntry) error {
	if a.err != nil {
		return a.err
	}
	a.entries = append(a.entries, e)
	return nil
}

func (a *fakeAudit) actions() []string {
	var out []string
	for _, e := range a.entries {
		out = append(out, e.Action)
	}
	return out
}

type fakeEvents struct{ n int }

func (e *fakeEvents) Publish(string, domain.Event) { e.n++ }

type passTx struct{}

func (passTx) Do(ctx context.Context, fn func(context.Context) error) error { return fn(ctx) }

type fixedClock struct{}

func (fixedClock) Now() time.Time { return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC) }

type seqIDs struct{ n int }

func (s *seqIDs) NewID() string { s.n++; return fmt.Sprintf("p%d", s.n) }

type env struct {
	svc    *ProjectService
	repo   *fakeRepo
	blobs  *fakeBlobs
	audit  *fakeAudit
	events *fakeEvents
}

func newEnv() *env {
	e := &env{repo: newFakeRepo(), blobs: &fakeBlobs{files: map[string][]byte{}}, audit: &fakeAudit{}, events: &fakeEvents{}}
	e.svc = NewProjectService(ProjectsDeps{
		Repo: e.repo, Blobs: e.blobs, Images: fakeImages{}, Audit: e.audit, Events: e.events,
		Tx: passTx{}, Clock: fixedClock{}, IDs: &seqIDs{},
	})
	return e
}

func actor(perms ...domain.Permission) domain.Actor {
	return domain.Actor{UserID: "u1", Perms: domain.NewPermissionSet(perms...)}
}

var (
	admin = actor(domain.AllPermissions()...)
	// worker has no write permissions at all.
	viewer = actor(domain.PermProjectView)
)

func mustCreate(t *testing.T, e *env, title string) ProjectView {
	t.Helper()
	v, err := e.svc.Create(context.Background(), admin, title)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// --- tests ---

func TestPermissionDenied(t *testing.T) {
	e := newEnv()
	ctx := context.Background()
	v := mustCreate(t, e, "P")
	none := actor()
	tests := map[string]func() error{
		"list":   func() error { _, err := e.svc.List(ctx, none, domain.ProjectFilter{}); return err },
		"create": func() error { _, err := e.svc.Create(ctx, viewer, "x"); return err },
		"get":    func() error { _, err := e.svc.Get(ctx, none, v.ID); return err },
		"update": func() error {
			t := "n"
			_, err := e.svc.Update(ctx, viewer, v.ID, UpdateProjectInput{Title: &t, Version: 1})
			return err
		},
		"finish": func() error { _, err := e.svc.Finish(ctx, viewer, v.ID); return err },
		"reopen": func() error { _, err := e.svc.Reopen(ctx, viewer, v.ID); return err },
		"delete": func() error { return e.svc.Delete(ctx, viewer, v.ID) },
		"put":    func() error { _, err := e.svc.PutImage(ctx, viewer, v.ID, "a.png", []byte("1x1:")); return err },
		"image":  func() error { _, err := e.svc.Image(ctx, none, v.ID, "", false); return err },
	}
	for name, f := range tests {
		if err := f(); !errors.Is(err, domain.ErrForbidden) {
			t.Errorf("%s: got %v, want FORBIDDEN", name, err)
		}
	}
}

func TestCreateValidatesAndAudits(t *testing.T) {
	e := newEnv()
	ctx := context.Background()
	if _, err := e.svc.Create(ctx, admin, "   "); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("empty title: %v", err)
	}
	v, err := e.svc.Create(ctx, admin, "  Giveaway  ")
	if err != nil {
		t.Fatal(err)
	}
	if v.Title != "Giveaway" || v.Version != 1 || v.Status != domain.ProjectActive || v.NextNumber != 1 || v.CreatedBy != "u1" {
		t.Fatalf("unexpected project %+v", v.Project)
	}
	if v.Placeholders != domain.DefaultPlaceholders(0, 0) || v.Image != nil {
		t.Fatal("expected default placeholders and no image")
	}
	if got := e.audit.actions(); !slices.Equal(got, []string{ActionProjectCreate}) {
		t.Fatalf("audit %v", got)
	}
}

func TestAuditFailureFailsOperation(t *testing.T) {
	e := newEnv()
	e.audit.err = errors.New("audit down")
	if _, err := e.svc.Create(context.Background(), admin, "X"); err == nil {
		t.Fatal("expected error")
	}
}

func TestListVisibility(t *testing.T) {
	e := newEnv()
	ctx := context.Background()
	a := mustCreate(t, e, "Alpha")
	b := mustCreate(t, e, "Beta")
	if _, err := e.svc.Finish(ctx, admin, b.ID); err != nil {
		t.Fatal(err)
	}
	fin, act := domain.ProjectFinished, domain.ProjectActive

	ids := func(vs []ProjectView) []string {
		var out []string
		for _, v := range vs {
			out = append(out, v.ID)
		}
		return out
	}

	got, err := e.svc.List(ctx, viewer, domain.ProjectFilter{})
	if err != nil || !slices.Equal(ids(got), []string{a.ID}) {
		t.Fatalf("viewer unfiltered: %v %v", ids(got), err)
	}
	if _, err := e.svc.List(ctx, viewer, domain.ProjectFilter{Status: &fin}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("viewer finished: %v", err)
	}
	got, _ = e.svc.List(ctx, admin, domain.ProjectFilter{})
	if len(got) != 2 {
		t.Fatalf("admin sees %d", len(got))
	}
	got, _ = e.svc.List(ctx, admin, domain.ProjectFilter{Status: &fin})
	if !slices.Equal(ids(got), []string{b.ID}) {
		t.Fatalf("finished filter: %v", ids(got))
	}
	got, _ = e.svc.List(ctx, admin, domain.ProjectFilter{Status: &act, Query: " alp "})
	if !slices.Equal(ids(got), []string{a.ID}) {
		t.Fatalf("query: %v", ids(got))
	}
	bad := domain.ProjectStatus("weird")
	if _, err := e.svc.List(ctx, admin, domain.ProjectFilter{Status: &bad}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("bad status: %v", err)
	}
	if _, err := e.svc.List(ctx, admin, domain.ProjectFilter{Query: strings.Repeat("x", 121)}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("long query: %v", err)
	}
}

func TestGetRegistersContributorAndHidesFinished(t *testing.T) {
	e := newEnv()
	ctx := context.Background()
	v := mustCreate(t, e, "P")
	if _, err := e.svc.Get(ctx, viewer, v.ID); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(e.repo.touched, []string{v.ID + "/u1"}) {
		t.Fatalf("touched %v", e.repo.touched)
	}
	if _, err := e.svc.Finish(ctx, admin, v.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Get(ctx, viewer, v.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("finished project must be hidden: %v", err)
	}
	if _, err := e.svc.Get(ctx, admin, v.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Get(ctx, admin, "missing"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("got %v", err)
	}
}

func TestUpdate(t *testing.T) {
	e := newEnv()
	ctx := context.Background()
	v := mustCreate(t, e, "Old")
	title := "New"
	ph := v.Placeholders.Name
	ph.Size = 80
	ph.X = 10

	got, err := e.svc.Update(ctx, admin, v.ID, UpdateProjectInput{Title: &title, Placeholders: &PlaceholdersPatch{Name: &ph}, Version: 1})
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "New" || got.Version != 2 || got.Placeholders.Name.Size != 80 || got.Placeholders.Number != v.Placeholders.Number {
		t.Fatalf("unexpected %+v", got.Project)
	}
	if e.events.n != 1 {
		t.Fatalf("events %d", e.events.n)
	}

	// Stale version: conflict carries the current project view.
	_, err = e.svc.Update(ctx, admin, v.ID, UpdateProjectInput{Title: &title, Version: 1})
	if !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("got %v", err)
	}
	var de *domain.Error
	if !errors.As(err, &de) {
		t.Fatal("not a domain error")
	}
	if cur, ok := de.Details["current"].(ProjectView); !ok || cur.Version != 2 {
		t.Fatalf("conflict details %+v", de.Details)
	}

	// Invalid placeholder reports field names.
	bad := ph
	bad.Font = "Comic Sans"
	_, err = e.svc.Update(ctx, admin, v.ID, UpdateProjectInput{Placeholders: &PlaceholdersPatch{Phone: &bad}, Version: 2})
	var ve *domain.ValidationError
	if !errors.As(err, &ve) || ve.Fields[0].Field != "placeholders.phone.font" {
		t.Fatalf("got %v", err)
	}

	empty := ""
	if _, err := e.svc.Update(ctx, admin, v.ID, UpdateProjectInput{Title: &empty, Version: 2}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("empty title: %v", err)
	}
	if _, err := e.svc.Update(ctx, admin, v.ID, UpdateProjectInput{Version: 2}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("empty patch: %v", err)
	}
	if _, err := e.svc.Update(ctx, admin, "missing", UpdateProjectInput{Title: &title, Version: 1}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
}

func TestUpdateRaceBecomesConflict(t *testing.T) {
	e := newEnv()
	v := mustCreate(t, e, "P")
	e.repo.saveErr = domain.ErrVersionConflict
	title := "x"
	_, err := e.svc.Update(context.Background(), admin, v.ID, UpdateProjectInput{Title: &title, Version: 1})
	if !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("got %v", err)
	}
}

func TestFinishedGuard(t *testing.T) {
	e := newEnv()
	ctx := context.Background()
	v := mustCreate(t, e, "P")
	if _, err := e.svc.Finish(ctx, admin, v.ID); err != nil {
		t.Fatal(err)
	}
	title := "x"
	if _, err := e.svc.Update(ctx, admin, v.ID, UpdateProjectInput{Title: &title, Version: 2}); !errors.Is(err, domain.ErrProjectFinished) {
		t.Fatalf("update: %v", err)
	}
	if _, err := e.svc.PutImage(ctx, admin, v.ID, "a.png", []byte("5x5:")); !errors.Is(err, domain.ErrProjectFinished) {
		t.Fatalf("image: %v", err)
	}
	if _, err := e.svc.Finish(ctx, admin, v.ID); !errors.Is(err, domain.ErrProjectFinished) {
		t.Fatalf("double finish: %v", err)
	}
	// A user who may finish but not see finished projects gets NOT_FOUND.
	finisher := actor(domain.PermProjectView, domain.PermProjectFinish)
	if _, err := e.svc.Reopen(ctx, finisher, v.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("hidden reopen: %v", err)
	}
	got, err := e.svc.Reopen(ctx, admin, v.ID)
	if err != nil || got.Status != domain.ProjectActive || got.FinishedAt != nil || got.Version != 3 {
		t.Fatalf("reopen: %+v %v", got.Project, err)
	}
	if _, err := e.svc.Reopen(ctx, admin, v.ID); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("reopen active: %v", err)
	}
	want := []string{ActionProjectCreate, ActionProjectFinish, ActionProjectReopen}
	if got := e.audit.actions(); !slices.Equal(got, want) {
		t.Fatalf("audit %v", got)
	}
}

func TestPutImageFirstUploadUsesDefaultsForSize(t *testing.T) {
	e := newEnv()
	ctx := context.Background()
	v := mustCreate(t, e, "P")
	got, err := e.svc.PutImage(ctx, admin, v.ID, `C:\fakepath\ticket.png`, []byte("2000x1000:data"))
	if err != nil {
		t.Fatal(err)
	}
	if got.Image == nil || got.Image.Name != "ticket.png" || got.Image.Width != 2000 || got.Image.Height != 1000 || got.Version != 2 {
		t.Fatalf("image %+v", got.Image)
	}
	if got.Placeholders != domain.DefaultPlaceholders(2000, 1000) {
		t.Fatal("placeholders should be the defaults for the image size")
	}
	if _, ok := e.blobs.files[got.Image.SHA256]; !ok {
		t.Fatal("blob not stored")
	}
	if !slices.Contains(e.audit.actions(), ActionImageUpload) {
		t.Fatal("no audit entry")
	}
}

func TestPutImageRescalesAndRemovesOldBlob(t *testing.T) {
	e := newEnv()
	ctx := context.Background()
	v := mustCreate(t, e, "P")
	first, err := e.svc.PutImage(ctx, admin, v.ID, "a.png", []byte("1000x500:one"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := e.svc.PutImage(ctx, admin, v.ID, "b.png", []byte("2000x1000:two"))
	if err != nil {
		t.Fatal(err)
	}
	want, _ := first.Placeholders.Rescaled(1000, 500, 2000, 1000)
	if second.Placeholders != want {
		t.Fatalf("placeholders not rescaled:\n got %+v\nwant %+v", second.Placeholders, want)
	}
	if _, ok := e.blobs.files[first.Image.SHA256]; ok {
		t.Fatal("old blob should be removed")
	}
	// Same dimensions: placeholders are untouched.
	third, err := e.svc.PutImage(ctx, admin, v.ID, "c.png", []byte("2000x1000:three"))
	if err != nil || third.Placeholders != second.Placeholders {
		t.Fatalf("same-size replace changed placeholders: %v", err)
	}
}

func TestPutImageKeepsSharedBlob(t *testing.T) {
	e := newEnv()
	ctx := context.Background()
	a, b := mustCreate(t, e, "A"), mustCreate(t, e, "B")
	data := []byte("100x100:same")
	va, _ := e.svc.PutImage(ctx, admin, a.ID, "x.png", data)
	_, _ = e.svc.PutImage(ctx, admin, b.ID, "x.png", data)
	if _, err := e.svc.PutImage(ctx, admin, a.ID, "y.png", []byte("100x100:other")); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.blobs.files[va.Image.SHA256]; !ok {
		t.Fatal("blob still referenced by B was removed")
	}
	if err := e.svc.Delete(ctx, admin, b.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.blobs.files[va.Image.SHA256]; ok {
		t.Fatal("blob should be removed with its last reference")
	}
}

func TestPutImageErrors(t *testing.T) {
	e := newEnv()
	ctx := context.Background()
	v := mustCreate(t, e, "P")
	if _, err := e.svc.PutImage(ctx, admin, v.ID, "a.png", []byte("garbage")); !errors.Is(err, domain.ErrImageInvalid) {
		t.Fatalf("invalid: %v", err)
	}
	e.blobs.full = true
	if _, err := e.svc.PutImage(ctx, admin, v.ID, "a.png", []byte("10x10:x")); !errors.Is(err, domain.ErrDiskLow) {
		t.Fatalf("disk: %v", err)
	}
	if _, err := e.svc.PutImage(ctx, admin, "missing", "a.png", []byte("10x10:x")); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if e.repo.projects[v.ID].Image != nil {
		t.Fatal("failed upload changed the project")
	}
}

func TestCleanFileName(t *testing.T) {
	tests := []struct{ in, mime, want string }{
		{"a.png", "image/png", "a.png"},
		{`..\..\evil.png`, "image/png", "evil.png"},
		{"../x/y.jpg", "image/jpeg", "y.jpg"},
		{"", "image/png", "image.png"},
		{"..", "image/jpeg", "image.jpg"},
		{"a\x00b\n.png", "image/png", "ab.png"},
		{strings.Repeat("я", 300), "image/png", strings.Repeat("я", 255)},
	}
	for _, tc := range tests {
		if got := cleanFileName(tc.in, tc.mime); got != tc.want {
			t.Errorf("cleanFileName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestImageDownload(t *testing.T) {
	e := newEnv()
	ctx := context.Background()
	v := mustCreate(t, e, "P")
	if _, err := e.svc.Image(ctx, admin, v.ID, "", false); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("no image: %v", err)
	}
	up, err := e.svc.PutImage(ctx, admin, v.ID, "a.png", []byte("10x10:pixels"))
	if err != nil {
		t.Fatal(err)
	}
	f, err := e.svc.Image(ctx, viewer, v.ID, "", false)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(f.Body)
	_ = f.Body.Close()
	if string(body) != "10x10:pixels" || f.ETag() != `"`+up.Image.SHA256+`"` {
		t.Fatalf("body %q etag %s", body, f.ETag())
	}
	for _, inm := range []string{f.ETag(), "W/" + f.ETag(), `"zzz", ` + f.ETag(), "*"} {
		g, err := e.svc.Image(ctx, viewer, v.ID, inm, false)
		if err != nil || !g.NotModified || g.Body != nil {
			t.Fatalf("If-None-Match %q: %+v %v", inm, g, err)
		}
	}
	if g, _ := e.svc.Image(ctx, viewer, v.ID, `"other"`, false); g.NotModified {
		t.Fatal("non-matching etag treated as match")
	}
	if _, err := e.svc.Finish(ctx, admin, v.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Image(ctx, viewer, v.ID, "", false); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("hidden: %v", err)
	}
}

func TestImageThumbnail(t *testing.T) {
	e := newEnv()
	ctx := context.Background()
	v := mustCreate(t, e, "P")
	up, err := e.svc.PutImage(ctx, admin, v.ID, "a.png", []byte("10x10:pixels"))
	if err != nil {
		t.Fatal(err)
	}
	if string(e.blobs.files[domain.ThumbKey(up.Image.SHA256)]) != "thumb:10x10:pixels" {
		t.Fatalf("preview not stored next to the original: %v", e.blobs.files)
	}
	f, err := e.svc.Image(ctx, viewer, v.ID, "", true)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(f.Body)
	_ = f.Body.Close()
	if string(body) != "thumb:10x10:pixels" || !f.Thumb || f.Meta.Mime != domain.MimeThumb ||
		f.ETag() != `"`+up.Image.SHA256+`-thumb"` {
		t.Fatalf("thumb: %q %+v etag %s", body, f.Meta, f.ETag())
	}
	if g, err := e.svc.Image(ctx, viewer, v.ID, f.ETag(), true); err != nil || !g.NotModified || g.Body != nil {
		t.Fatalf("thumb 304: %+v %v", g, err)
	}
	// The original's tag does not match the preview.
	if g, _ := e.svc.Image(ctx, viewer, v.ID, `"`+up.Image.SHA256+`"`, true); g.NotModified {
		t.Fatal("original etag accepted for the preview")
	}
	// An image stored before previews existed falls back to the original.
	delete(e.blobs.files, domain.ThumbKey(up.Image.SHA256))
	g, err := e.svc.Image(ctx, viewer, v.ID, "", true)
	if err != nil || g.Thumb || g.Body == nil {
		t.Fatalf("fallback: %+v %v", g, err)
	}
	_ = g.Body.Close()
}

func TestDeleteAndGC(t *testing.T) {
	e := newEnv()
	ctx := context.Background()
	v := mustCreate(t, e, "P")
	up, _ := e.svc.PutImage(ctx, admin, v.ID, "a.png", []byte("10x10:x"))
	if err := e.svc.Delete(ctx, admin, v.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.blobs.files[up.Image.SHA256]; ok {
		t.Fatal("blob not deleted")
	}
	if err := e.svc.Delete(ctx, admin, v.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
	keep := mustCreate(t, e, "K")
	k, _ := e.svc.PutImage(ctx, admin, keep.ID, "k.png", []byte("10x10:k"))
	if _, err := e.svc.CollectGarbage(ctx); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.blobs.gcRefs[k.Image.SHA256]; !ok || len(e.blobs.gcRefs) != 1 {
		t.Fatalf("gc refs %v", e.blobs.gcRefs)
	}
}
