package http

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/rs/zerolog"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/logging"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

const (
	testProjectID = "0198f2f0-7a3c-7c1e-9b57-2f4d5a6b7c8d"
	testUserID    = "0198f2f0-7a3c-7c1e-9b57-000000000001"
	testSHA       = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12"
)

type fakeProjects struct {
	view     service.ProjectView
	err      error
	filter   domain.ProjectFilter
	update   service.UpdateProjectInput
	created  string
	putName  string
	putData  []byte
	image    service.ImageFile
	deleted  string
	inm      string
	listOut  []service.ProjectView
	gotActor domain.Actor
}

func (f *fakeProjects) List(_ context.Context, a domain.Actor, fl domain.ProjectFilter) ([]service.ProjectView, error) {
	f.gotActor, f.filter = a, fl
	return f.listOut, f.err
}
func (f *fakeProjects) Create(_ context.Context, _ domain.Actor, title string) (service.ProjectView, error) {
	f.created = title
	return f.view, f.err
}
func (f *fakeProjects) Get(context.Context, domain.Actor, string) (service.ProjectView, error) {
	return f.view, f.err
}
func (f *fakeProjects) Update(_ context.Context, _ domain.Actor, _ string, in service.UpdateProjectInput) (service.ProjectView, error) {
	f.update = in
	return f.view, f.err
}
func (f *fakeProjects) Finish(context.Context, domain.Actor, string) (service.ProjectView, error) {
	return f.view, f.err
}
func (f *fakeProjects) Reopen(context.Context, domain.Actor, string) (service.ProjectView, error) {
	return f.view, f.err
}
func (f *fakeProjects) Delete(_ context.Context, _ domain.Actor, id string) error {
	f.deleted = id
	return f.err
}
func (f *fakeProjects) PutImage(_ context.Context, _ domain.Actor, _, name string, data []byte) (service.ProjectView, error) {
	f.putName, f.putData = name, data
	return f.view, f.err
}
func (f *fakeProjects) Image(_ context.Context, _ domain.Actor, _, inm string) (service.ImageFile, error) {
	f.inm = inm
	return f.image, f.err
}

// projectsTestServer embeds gen.Unimplemented one level deeper than the handler, so the handler wins.
type projectsTestServer struct {
	*ProjectsHandler
	unimplemented
}

type unimplemented struct{ gen.Unimplemented }

func newProjectsTestServer(t *testing.T, maxImage int64) (http.Handler, *fakeProjects) {
	t.Helper()
	fake := &fakeProjects{}
	srv := projectsTestServer{ProjectsHandler: NewProjectsHandler(fake, maxImage)}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := logging.WithLogger(req.Context(), zerolog.Nop())
			if req.Header.Get("X-Test-Anonymous") == "" {
				ctx = WithActor(ctx, domain.Actor{UserID: testUserID, Perms: domain.NewPermissionSet(domain.AllPermissions()...)})
			}
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	return gen.HandlerFromMux(srv, r), fake
}

func sampleView() service.ProjectView {
	ph := domain.DefaultPlaceholders(1000, 500)
	return service.ProjectView{
		Project: domain.Project{
			ID: testProjectID, Title: "Giveaway", Status: domain.ProjectActive, Version: 3,
			CreatedAt:    time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
			Placeholders: ph,
			Image:        &domain.ImageMeta{SHA256: testSHA, Name: "t.png", Mime: "image/png", Width: 1000, Height: 500, Bytes: 99},
		},
		ProjectDetails: domain.ProjectDetails{
			ParticipantCount: 7,
			Contributors: []domain.Contributor{
				{ID: testUserID, DisplayName: "Alice", Color: "#ffb84d", AvatarSHA: testSHA},
				{ID: uuid.NewString(), DisplayName: "Bob", Color: "#6cb4ff"},
			},
		},
	}
}

func call(h http.Handler, method, path string, body io.Reader, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, body)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeErr(t *testing.T, rec *httptest.ResponseRecorder) errorBody {
	t.Helper()
	var env errorEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("not an error envelope: %s", rec.Body.String())
	}
	return env.Error
}

func TestProjectsGetMapsProject(t *testing.T) {
	h, fake := newProjectsTestServer(t, 1<<20)
	fake.view = sampleView()
	rec := call(h, "GET", "/projects/"+testProjectID, nil, nil)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var got gen.ProjectResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	p := got.Project
	if p.Id.String() != testProjectID || p.Title != "Giveaway" || p.Version != 3 || p.ParticipantCount != 7 || p.Status != "active" {
		t.Fatalf("project %+v", p)
	}
	if p.Image == nil || p.Image.Url != "/api/v1/projects/"+testProjectID+"/image?v=ab12cd34" || p.Image.W != 1000 || p.Image.Bytes != 99 {
		t.Fatalf("image %+v", p.Image)
	}
	if len(p.Contributors) != 2 || p.Contributors[0].AvatarUrl == nil || p.Contributors[1].AvatarUrl != nil {
		t.Fatalf("contributors %+v", p.Contributors)
	}
	if *p.Contributors[0].AvatarUrl != "/api/v1/users/"+testUserID+"/avatar?v=ab12cd34" {
		t.Fatalf("avatar url %s", *p.Contributors[0].AvatarUrl)
	}
	if p.Placeholders.Name.Font != "Montserrat" || p.Placeholders.Number.X != 500 {
		t.Fatalf("placeholders %+v", p.Placeholders)
	}
}

func TestProjectsNullImageAndEmptyLists(t *testing.T) {
	h, fake := newProjectsTestServer(t, 1<<20)
	v := sampleView()
	v.Image = nil
	v.Contributors = nil
	fake.view = v
	rec := call(h, "GET", "/projects/"+testProjectID, nil, nil)
	if !strings.Contains(rec.Body.String(), `"image":null`) || !strings.Contains(rec.Body.String(), `"contributors":[]`) {
		t.Fatalf("body %s", rec.Body)
	}
	fake.listOut = nil
	rec = call(h, "GET", "/projects", nil, nil)
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("empty list body %q", rec.Body)
	}
}

func TestProjectsList(t *testing.T) {
	h, fake := newProjectsTestServer(t, 1<<20)
	fake.listOut = []service.ProjectView{sampleView()}
	rec := call(h, "GET", "/projects?status=finished&q=bmw", nil, nil)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if fake.filter.Status == nil || *fake.filter.Status != domain.ProjectFinished || fake.filter.Query != "bmw" {
		t.Fatalf("filter %+v", fake.filter)
	}
	var cards []gen.ProjectCard
	if err := json.Unmarshal(rec.Body.Bytes(), &cards); err != nil || len(cards) != 1 {
		t.Fatalf("cards %v %v", cards, err)
	}
	if cards[0].Image == nil || cards[0].ParticipantCount != 7 || len(cards[0].Contributors) != 2 {
		t.Fatalf("card %+v", cards[0])
	}
	if rec := call(h, "GET", "/projects", nil, nil); rec.Code != 200 || fake.filter.Status != nil {
		t.Fatalf("unfiltered: %d %+v", rec.Code, fake.filter)
	}
}

func TestProjectsCreate(t *testing.T) {
	h, fake := newProjectsTestServer(t, 1<<20)
	fake.view = sampleView()
	rec := call(h, "POST", "/projects", strings.NewReader(`{"title":"New"}`), map[string]string{"Content-Type": "application/json"})
	if rec.Code != 201 || fake.created != "New" {
		t.Fatalf("status %d created %q", rec.Code, fake.created)
	}
	rec = call(h, "POST", "/projects", strings.NewReader(`{"title":"x","bogus":1}`), map[string]string{"Content-Type": "application/json"})
	if rec.Code != 400 || decodeErr(t, rec).Code != "VALIDATION" {
		t.Fatalf("unknown field: %d %s", rec.Code, rec.Body)
	}
}

func TestProjectsUpdate(t *testing.T) {
	h, fake := newProjectsTestServer(t, 1<<20)
	fake.view = sampleView()
	body := `{"version":3,"title":"T","placeholders":{"name":{"font":"Inter","size":50,"stroke":2,"color":"#ffffff","strokeColor":"#000000","bold":true,"italic":false,"underline":false,"x":10,"y":20}}}`
	rec := call(h, "PATCH", "/projects/"+testProjectID, strings.NewReader(body), map[string]string{"Content-Type": "application/json"})
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	in := fake.update
	if in.Version != 3 || in.Title == nil || *in.Title != "T" || in.Placeholders == nil ||
		in.Placeholders.Number != nil || in.Placeholders.Phone != nil ||
		in.Placeholders.Name == nil || in.Placeholders.Name.Font != "Inter" || in.Placeholders.Name.X != 10 || !in.Placeholders.Name.Bold {
		t.Fatalf("input %+v", in)
	}
	rec = call(h, "PATCH", "/projects/"+testProjectID, strings.NewReader(`{"title":"T"}`), map[string]string{"Content-Type": "application/json"})
	if rec.Code != 400 {
		t.Fatalf("missing version: %d", rec.Code)
	}
}

func TestProjectsVersionConflictRendersAPIShape(t *testing.T) {
	h, fake := newProjectsTestServer(t, 1<<20)
	fake.err = domain.NewVersionConflict(sampleView())
	rec := call(h, "PATCH", "/projects/"+testProjectID, strings.NewReader(`{"version":1,"title":"x"}`), map[string]string{"Content-Type": "application/json"})
	if rec.Code != 409 {
		t.Fatalf("status %d", rec.Code)
	}
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Details struct {
				Current gen.Project `json:"current"`
			} `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if env.Error.Code != "VERSION_CONFLICT" || env.Error.Details.Current.Version != 3 || env.Error.Details.Current.Title != "Giveaway" {
		t.Fatalf("body %s", rec.Body)
	}
}

func TestProjectsErrorStatuses(t *testing.T) {
	h, fake := newProjectsTestServer(t, 1<<20)
	tests := []struct {
		err    error
		status int
		code   string
	}{
		{domain.ErrForbidden, 403, "FORBIDDEN"},
		{domain.ErrNotFound, 404, "NOT_FOUND"},
		{domain.ErrProjectFinished, 409, "PROJECT_FINISHED"},
		{domain.ErrTooLarge, 413, "TOO_LARGE"},
		{domain.ErrUnsupportedMedia, 415, "UNSUPPORTED_MEDIA"},
		{domain.ErrImageInvalid, 422, "IMAGE_INVALID"},
		{domain.ErrDiskLow, 507, "DISK_LOW"},
	}
	for _, tc := range tests {
		fake.err = tc.err
		rec := call(h, "POST", "/projects/"+testProjectID+"/finish", nil, nil)
		if rec.Code != tc.status || decodeErr(t, rec).Code != tc.code {
			t.Errorf("%v: %d %s", tc.err, rec.Code, rec.Body)
		}
	}
}

func TestProjectsDeleteFinishReopen(t *testing.T) {
	h, fake := newProjectsTestServer(t, 1<<20)
	fake.view = sampleView()
	if rec := call(h, "DELETE", "/projects/"+testProjectID, nil, nil); rec.Code != 204 || fake.deleted != testProjectID {
		t.Fatalf("delete %d %q", rec.Code, fake.deleted)
	}
	for _, op := range []string{"finish", "reopen"} {
		if rec := call(h, "POST", "/projects/"+testProjectID+"/"+op, nil, nil); rec.Code != 200 {
			t.Errorf("%s: %d", op, rec.Code)
		}
	}
}

func TestProjectsUnauthenticated(t *testing.T) {
	h, _ := newProjectsTestServer(t, 1<<20)
	rec := call(h, "GET", "/projects", nil, map[string]string{"X-Test-Anonymous": "1"})
	if rec.Code != 401 || decodeErr(t, rec).Code != "UNAUTHENTICATED" {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func multipartBody(t *testing.T, field, filename string, content []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	hdr := textproto.MIMEHeader{}
	hdr.Set("Content-Disposition", `form-data; name="`+field+`"; filename="`+filename+`"`)
	hdr.Set("Content-Type", "image/png")
	part, err := mw.CreatePart(hdr)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(content)
	_ = mw.Close()
	return &buf, mw.FormDataContentType()
}

func TestProjectsPutImage(t *testing.T) {
	h, fake := newProjectsTestServer(t, 1000)
	fake.view = sampleView()

	body, ct := multipartBody(t, "file", "ticket.png", []byte("PNGDATA"))
	rec := call(h, "PUT", "/projects/"+testProjectID+"/image", body, map[string]string{"Content-Type": ct})
	if rec.Code != 200 || fake.putName != "ticket.png" || string(fake.putData) != "PNGDATA" {
		t.Fatalf("status %d name %q data %q body %s", rec.Code, fake.putName, fake.putData, rec.Body)
	}

	// Wrong field name -> 400.
	body, ct = multipartBody(t, "other", "x.png", []byte("x"))
	rec = call(h, "PUT", "/projects/"+testProjectID+"/image", body, map[string]string{"Content-Type": ct})
	if rec.Code != 400 {
		t.Fatalf("missing file part: %d", rec.Code)
	}

	// Not multipart -> 400.
	rec = call(h, "PUT", "/projects/"+testProjectID+"/image", strings.NewReader("raw"), map[string]string{"Content-Type": "image/png"})
	if rec.Code != 400 {
		t.Fatalf("not multipart: %d", rec.Code)
	}

	// Empty file -> 400.
	body, ct = multipartBody(t, "file", "x.png", nil)
	rec = call(h, "PUT", "/projects/"+testProjectID+"/image", body, map[string]string{"Content-Type": ct})
	if rec.Code != 400 {
		t.Fatalf("empty file: %d", rec.Code)
	}

	// File over the limit (streamed, no Content-Length shortcut) -> 413.
	big := bytes.Repeat([]byte("a"), 1001)
	body, ct = multipartBody(t, "file", "big.png", big)
	req := httptest.NewRequest("PUT", "/projects/"+testProjectID+"/image", io.NopCloser(body))
	req.ContentLength = -1
	req.Header.Set("Content-Type", ct)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 413 || decodeErr(t, rec).Code != "TOO_LARGE" {
		t.Fatalf("oversize: %d %s", rec.Code, rec.Body)
	}

	// Declared Content-Length far above the limit is rejected up front.
	body, ct = multipartBody(t, "file", "big.png", bytes.Repeat([]byte("a"), 200_000))
	rec = call(h, "PUT", "/projects/"+testProjectID+"/image", body, map[string]string{"Content-Type": ct})
	if rec.Code != 413 {
		t.Fatalf("declared oversize: %d", rec.Code)
	}
}

func TestProjectsGetImage(t *testing.T) {
	h, fake := newProjectsTestServer(t, 1<<20)
	etag := `"` + testSHA + `"`
	fake.image = service.ImageFile{
		Meta: domain.ImageMeta{SHA256: testSHA, Mime: "image/png"},
		Body: nopCloser{strings.NewReader("pixels")},
	}
	rec := call(h, "GET", "/projects/"+testProjectID+"/image", nil, nil)
	if rec.Code != 200 || rec.Body.String() != "pixels" {
		t.Fatalf("%d %q", rec.Code, rec.Body)
	}
	if rec.Header().Get("ETag") != etag || rec.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" ||
		rec.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("headers %v", rec.Header())
	}

	fake.image = service.ImageFile{Meta: domain.ImageMeta{SHA256: testSHA, Mime: "image/png"}, NotModified: true}
	rec = call(h, "GET", "/projects/"+testProjectID+"/image", nil, map[string]string{"If-None-Match": etag})
	if rec.Code != 304 || rec.Body.Len() != 0 || fake.inm != etag || rec.Header().Get("ETag") != etag {
		t.Fatalf("304: %d %q inm=%q", rec.Code, rec.Body, fake.inm)
	}

	fake.err = domain.ErrNotFound
	if rec := call(h, "GET", "/projects/"+testProjectID+"/image", nil, nil); rec.Code != 404 {
		t.Fatalf("not found: %d", rec.Code)
	}
}

type nopCloser struct{ *strings.Reader }

func (nopCloser) Close() error { return nil }
