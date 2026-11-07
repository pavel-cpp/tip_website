package http

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func spaTestHandler() http.Handler {
	return NewSPAHandler(fstest.MapFS{
		"index.html":            {Data: []byte("<!doctype html><title>TIP</title>")},
		"assets/app-abc123.js":  {Data: []byte("console.log(1)")},
		"assets/app-abc123.css": {Data: []byte("body{}")},
		"manifest.webmanifest":  {Data: []byte("{}")},
		"icon.svg":              {Data: []byte("<svg/>")},
	})
}

func spaDo(h http.Handler, method, target string, hdr ...string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestSPAIndexNoCache(t *testing.T) {
	h := spaTestHandler()
	for _, p := range []string{"/", "/index.html"} {
		rec := spaDo(h, http.MethodGet, p)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "<title>TIP</title>") {
			t.Fatalf("%s: %d %q", p, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Errorf("%s: Cache-Control = %q", p, got)
		}
		if got := rec.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
			t.Errorf("%s: Content-Type = %q", p, got)
		}
	}
}

func TestSPAIndexConditionalRequest(t *testing.T) {
	h := spaTestHandler()
	etag := spaDo(h, http.MethodGet, "/").Header().Get("ETag")
	if etag == "" {
		t.Fatal("index must carry an ETag")
	}
	rec := spaDo(h, http.MethodGet, "/", "If-None-Match", etag)
	if rec.Code != http.StatusNotModified {
		t.Errorf("status = %d, want 304", rec.Code)
	}
}

func TestSPAAssetsImmutable(t *testing.T) {
	h := spaTestHandler()
	cases := map[string]string{
		"/assets/app-abc123.js":  "text/javascript; charset=utf-8",
		"/assets/app-abc123.css": "text/css; charset=utf-8",
	}
	for p, ct := range cases {
		rec := spaDo(h, http.MethodGet, p)
		if rec.Code != 200 {
			t.Fatalf("%s: %d", p, rec.Code)
		}
		if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
			t.Errorf("%s: Cache-Control = %q", p, got)
		}
		if got := rec.Header().Get("Content-Type"); got != ct {
			t.Errorf("%s: Content-Type = %q, want %q", p, got, ct)
		}
	}
}

func TestSPAStaticRootFiles(t *testing.T) {
	h := spaTestHandler()
	rec := spaDo(h, http.MethodGet, "/manifest.webmanifest")
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "application/manifest+json" {
		t.Errorf("manifest: %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=3600" {
		t.Errorf("Cache-Control = %q", got)
	}
	if got := spaDo(h, http.MethodGet, "/icon.svg").Header().Get("Content-Type"); got != "image/svg+xml" {
		t.Errorf("svg Content-Type = %q", got)
	}
}

func TestSPAClientRouteFallsBackToIndex(t *testing.T) {
	h := spaTestHandler()
	for _, p := range []string{"/projects", "/projects/123/settings", "/admin/system", "/assets"} {
		rec := spaDo(h, http.MethodGet, p)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "<title>TIP</title>") {
			t.Errorf("%s: %d %q", p, rec.Code, rec.Body.String())
		}
	}
}

func TestSPAMissingFilesAre404(t *testing.T) {
	h := spaTestHandler()
	for _, p := range []string{"/assets/missing.js", "/assets/", "/favicon.ico", "/nope.map"} {
		rec := spaDo(h, http.MethodGet, p)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", p, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "<title>") {
			t.Errorf("%s: must not return the SPA shell", p)
		}
	}
}

func TestSPANeverServesIndexForAPI(t *testing.T) {
	h := spaTestHandler()
	for _, p := range []string{"/api", "/api/", "/api/v1/unknown", "/api/docs/x"} {
		rec := spaDo(h, http.MethodGet, p)
		if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"NOT_FOUND"`) {
			t.Errorf("%s: %d %q", p, rec.Code, rec.Body.String())
		}
	}
}

func TestSPAHeadAndMethods(t *testing.T) {
	h := spaTestHandler()
	rec := spaDo(h, http.MethodHead, "/projects")
	if rec.Code != 200 || rec.Body.Len() != 0 {
		t.Errorf("HEAD: %d body=%q", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Content-Type") == "" {
		t.Error("HEAD must carry Content-Type")
	}
	rec = spaDo(h, http.MethodHead, "/assets/app-abc123.js")
	if rec.Code != 200 || rec.Body.Len() != 0 || rec.Header().Get("Cache-Control") == "" {
		t.Errorf("HEAD asset: %d", rec.Code)
	}
	rec = spaDo(h, http.MethodPost, "/projects")
	if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "GET, HEAD" {
		t.Errorf("POST: %d allow=%q", rec.Code, rec.Header().Get("Allow"))
	}
}

func TestSPATraversalIsContained(t *testing.T) {
	h := spaTestHandler()
	rec := spaDo(h, http.MethodGet, "/assets/../../etc/passwd")
	if strings.Contains(rec.Body.String(), "root:") {
		t.Fatal("path traversal leaked a file")
	}
}

func TestSPAWithoutBuiltFrontend(t *testing.T) {
	h := NewSPAHandler(fstest.MapFS{".gitkeep": {}})
	rec := spaDo(h, http.MethodGet, "/projects")
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
}
