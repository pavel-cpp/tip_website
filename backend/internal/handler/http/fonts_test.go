package http

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/logging"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

const testFontID = "0198f2f0-7a3c-7c1e-9b57-2f4d5a6b7c8e"

type fakeFonts struct {
	list     []domain.Font
	file     service.FontFile
	err      error
	name     string
	licence  bool
	data     []byte
	deleted  string
	inm      string
	uploaded domain.Font
}

func (f *fakeFonts) List(context.Context, domain.Actor) ([]domain.Font, error) { return f.list, f.err }
func (f *fakeFonts) Upload(_ context.Context, _ domain.Actor, name string, lic bool, data []byte) (domain.Font, error) {
	f.name, f.licence, f.data = name, lic, data
	return f.uploaded, f.err
}
func (f *fakeFonts) Delete(_ context.Context, _ domain.Actor, id string) error {
	f.deleted = id
	return f.err
}
func (f *fakeFonts) File(_ context.Context, _ domain.Actor, _, inm string) (service.FontFile, error) {
	f.inm = inm
	return f.file, f.err
}

type fontsTestServer struct {
	*FontsHandler
	unimplemented
}

func newFontsTestServer(t *testing.T) (http.Handler, *fakeFonts) {
	t.Helper()
	fake := &fakeFonts{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := logging.WithLogger(req.Context(), zerolog.Nop())
			ctx = WithActor(ctx, domain.Actor{UserID: testUserID, Perms: domain.NewPermissionSet(domain.AllPermissions()...)})
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	return gen.HandlerFromMux(fontsTestServer{FontsHandler: NewFontsHandler(fake)}, r), fake
}

func sampleFont() domain.Font {
	return domain.Font{
		ID: testFontID, Name: "Brand", Format: domain.FontFormatWOFF2, SHA256: testSHA, Bytes: 1234,
		CreatedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
	}
}

func fontForm(t *testing.T, fields map[string]string, file []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatal(err)
		}
	}
	if file != nil {
		part, err := mw.CreateFormFile("file", "x.woff2")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write(file)
	}
	_ = mw.Close()
	return &buf, mw.FormDataContentType()
}

func TestFontsList(t *testing.T) {
	h, fake := newFontsTestServer(t)
	rec := call(h, "GET", "/fonts", nil, nil)
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("empty list body %q", rec.Body)
	}
	fake.list = []domain.Font{sampleFont()}
	rec = call(h, "GET", "/fonts", nil, nil)
	var got []gen.Font
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || len(got) != 1 {
		t.Fatalf("body %s (%v)", rec.Body, err)
	}
	if got[0].Id.String() != testFontID || got[0].Format != gen.Woff2 || got[0].Url != "/api/v1/fonts/"+testFontID+"/file?v=ab12cd34" {
		t.Fatalf("font %+v", got[0])
	}
}

func TestFontsUpload(t *testing.T) {
	h, fake := newFontsTestServer(t)
	fake.uploaded = sampleFont()
	body, ct := fontForm(t, map[string]string{"name": "Brand", "licenseConfirmed": "true"}, []byte("wOF2-data"))
	rec := call(h, "POST", "/fonts", body, map[string]string{"Content-Type": ct})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if fake.name != "Brand" || !fake.licence || string(fake.data) != "wOF2-data" {
		t.Fatalf("service got %q %v %q", fake.name, fake.licence, fake.data)
	}

	// The licence flag defaults to false when absent.
	body, ct = fontForm(t, map[string]string{"name": "Brand"}, []byte("data"))
	call(h, "POST", "/fonts", body, map[string]string{"Content-Type": ct})
	if fake.licence {
		t.Fatal("licence must default to false")
	}
}

func TestFontsUploadErrors(t *testing.T) {
	h, fake := newFontsTestServer(t)

	body, ct := fontForm(t, map[string]string{"name": "x"}, nil)
	if rec := call(h, "POST", "/fonts", body, map[string]string{"Content-Type": ct}); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing file: %d %s", rec.Code, rec.Body)
	}
	if rec := call(h, "POST", "/fonts", strings.NewReader("{}"), map[string]string{"Content-Type": "application/json"}); rec.Code != http.StatusBadRequest {
		t.Fatalf("not multipart: %d", rec.Code)
	}

	big := bytes.Repeat([]byte{1}, domain.MaxFontBytes+1)
	body, ct = fontForm(t, map[string]string{"name": "x", "licenseConfirmed": "true"}, big)
	rec := call(h, "POST", "/fonts", body, map[string]string{"Content-Type": ct})
	if rec.Code != http.StatusRequestEntityTooLarge || decodeErr(t, rec).Code != "TOO_LARGE" {
		t.Fatalf("oversized: %d %s", rec.Code, rec.Body)
	}

	fake.err = domain.ErrUnsupportedMedia
	body, ct = fontForm(t, map[string]string{"name": "x", "licenseConfirmed": "true"}, []byte("png"))
	if rec := call(h, "POST", "/fonts", body, map[string]string{"Content-Type": ct}); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("unsupported: %d", rec.Code)
	}
}

func TestFontsDelete(t *testing.T) {
	h, fake := newFontsTestServer(t)
	if rec := call(h, "DELETE", "/fonts/"+testFontID, nil, nil); rec.Code != http.StatusNoContent || fake.deleted != testFontID {
		t.Fatalf("delete: %d %q", rec.Code, fake.deleted)
	}
	fake.err = domain.NewValidation(domain.FieldError{Field: "id", Reason: "the font is used by a project"})
	if rec := call(h, "DELETE", "/fonts/"+testFontID, nil, nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("in use: %d", rec.Code)
	}
	if rec := call(h, "DELETE", "/fonts/not-a-uuid", nil, nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad id: %d", rec.Code)
	}
}

type memBody struct{ *bytes.Reader }

func (memBody) Close() error { return nil }

func TestFontsFile(t *testing.T) {
	h, fake := newFontsTestServer(t)
	f := sampleFont()
	fake.file = service.FontFile{Font: f, Body: memBody{bytes.NewReader([]byte("wOF2-data"))}}

	rec := call(h, "GET", "/fonts/"+testFontID+"/file", nil, map[string]string{"If-None-Match": `"x"`})
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if got, _ := io.ReadAll(rec.Body); string(got) != "wOF2-data" {
		t.Fatalf("body %q", got)
	}
	hd := rec.Header()
	if hd.Get("Content-Type") != "font/woff2" || hd.Get("ETag") != `"`+testSHA+`"` ||
		hd.Get("Cache-Control") != "public, max-age=31536000, immutable" || fake.inm != `"x"` {
		t.Fatalf("headers %v inm=%q", hd, fake.inm)
	}

	fake.file = service.FontFile{Font: f, NotModified: true}
	if rec := call(h, "GET", "/fonts/"+testFontID+"/file", nil, nil); rec.Code != http.StatusNotModified || rec.Body.Len() != 0 {
		t.Fatalf("304: %d", rec.Code)
	}

	fake.err = domain.ErrNotFound
	if rec := call(h, "GET", "/fonts/"+testFontID+"/file", nil, nil); rec.Code != http.StatusNotFound {
		t.Fatalf("404: %d", rec.Code)
	}
}
