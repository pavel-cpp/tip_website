package http

import (
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// swaggerTestRouter mirrors the production order: security headers first, then the routes.
func swaggerTestRouter(mount bool) http.Handler {
	r := chi.NewRouter()
	r.Use(securityHeaders(defaultCSP))
	MountSwagger(r, mount)
	r.Get("/other", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	return r
}

func TestSwaggerUIPage(t *testing.T) {
	rec := spaDo(swaggerTestRouter(true), http.MethodGet, "/api/docs")
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "swagger-ui-bundle.js") || !strings.Contains(body, "/api/openapi.yaml") {
		t.Errorf("page does not reference the bundle and the spec: %s", body)
	}
	if strings.Contains(body, "unpkg.com") || strings.Contains(body, "cdn") {
		t.Error("Swagger UI must not load assets from a CDN")
	}
	if csp := rec.Header().Get("Content-Security-Policy"); csp != swaggerCSP {
		t.Errorf("CSP = %q", csp)
	}
}

func TestSwaggerTrailingSlashAndAssets(t *testing.T) {
	h := swaggerTestRouter(true)
	if rec := spaDo(h, http.MethodGet, "/api/docs/"); rec.Code != 200 || !strings.Contains(rec.Body.String(), "swagger-ui") {
		t.Errorf("/api/docs/: %d", rec.Code)
	}
	rec := spaDo(h, http.MethodGet, "/api/docs/swagger-ui-bundle.js", "Accept-Encoding", "gzip")
	if rec.Code != 200 || rec.Body.Len() < 1000 {
		t.Fatalf("bundle: %d, %d bytes", rec.Code, rec.Body.Len())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Errorf("bundle Content-Type = %q", ct)
	}
	if rec := spaDo(h, http.MethodGet, "/api/docs/swagger-ui.css"); rec.Code != 200 {
		t.Errorf("css: %d", rec.Code)
	}
}

func TestSwaggerSpec(t *testing.T) {
	rec := spaDo(swaggerTestRouter(true), http.MethodGet, "/api/openapi.yaml")
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/yaml") {
		t.Errorf("Content-Type = %q", rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Body.String(), "openapi: 3.1") {
		t.Errorf("not an OpenAPI 3.1 document: %.80s", rec.Body.String())
	}
}

func TestSwaggerRelaxedCSPOnlyOnDocs(t *testing.T) {
	h := swaggerTestRouter(true)
	if csp := spaDo(h, http.MethodGet, "/other").Header().Get("Content-Security-Policy"); csp != defaultCSP {
		t.Errorf("other routes must keep the strict CSP, got %q", csp)
	}
	if csp := spaDo(h, http.MethodGet, "/api/openapi.yaml").Header().Get("Content-Security-Policy"); csp != defaultCSP {
		t.Errorf("the spec route must keep the strict CSP, got %q", csp)
	}
	if strings.Contains(defaultCSP, "unsafe-inline") {
		t.Error("the default CSP must stay strict")
	}
}

func TestSwaggerDisabledByNotMounting(t *testing.T) {
	h := swaggerTestRouter(false)
	for _, p := range []string{"/api/docs", "/api/openapi.yaml"} {
		if rec := spaDo(h, http.MethodGet, p); rec.Code != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", p, rec.Code)
		}
	}
}

func TestSwaggerHeadAndPost(t *testing.T) {
	h := swaggerTestRouter(true)
	if rec := spaDo(h, http.MethodHead, "/api/docs"); rec.Code != 200 {
		t.Errorf("HEAD: %d", rec.Code)
	}
	if rec := spaDo(h, http.MethodPost, "/api/docs"); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST: %d", rec.Code)
	}
}
