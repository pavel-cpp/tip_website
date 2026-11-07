package http

// Wiring (done by the lead in server.go): MountSwagger(r, cfg.SwaggerEnabled).
//
// MountSwagger registers GET /api/docs, /api/docs/* (embedded Swagger UI assets, no CDN) and
// GET /api/openapi.yaml. Register it before the catch-all SPA handler.

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/swaggest/swgui/v5emb"

	"github.com/pavel-cpp/tip_website/backend/api"
)

const (
	swaggerDocsPath = "/api/docs"
	swaggerSpecPath = "/api/openapi.yaml"
)

// swaggerCSP is the relaxed policy for the documentation page only. Swagger UI bootstraps
// itself with an inline script and injects inline styles; everything else stays same-origin,
// so a compromised spec still cannot load remote code.
const swaggerCSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"

// MountSwagger registers Swagger UI and the OpenAPI document on r. With enabled false
// (SWAGGER_ENABLED=false) it registers nothing, so the paths fall through to 404.
func MountSwagger(r chi.Router, enabled bool) {
	if !enabled {
		return
	}
	ui := v5emb.New("TIP API", swaggerSpecPath, swaggerDocsPath+"/")
	docs := swaggerCSPMiddleware(ui)
	r.Method(http.MethodGet, swaggerDocsPath, docs)
	r.Method(http.MethodHead, swaggerDocsPath, docs)
	r.Method(http.MethodGet, swaggerDocsPath+"/*", docs)
	r.Method(http.MethodHead, swaggerDocsPath+"/*", docs)
	r.Get(swaggerSpecPath, swaggerSpec)
}

// swaggerCSPMiddleware overrides the strict default policy for the documentation routes.
func swaggerCSPMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", swaggerCSP)
		next.ServeHTTP(w, r)
	})
}

func swaggerSpec(w http.ResponseWriter, _ *http.Request) {
	h := w.Header()
	h.Set("Content-Type", "application/yaml; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	_, _ = w.Write(api.Spec) // the status is already sent; a failed write has no better recovery
}
