package http

// Wiring (done by the lead in server.go): the SPA handler is the router's catch-all, so that
// every path no API route claims reaches it:
//
//	r.NotFound(NewSPAHandler(web.FS()).ServeHTTP)
//
// It answers /api/... paths with the JSON 404 envelope and never falls back to index.html there.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"
)

const (
	spaIndex          = "index.html"
	spaAssetsPrefix   = "assets/"
	spaImmutableCache = "public, max-age=31536000, immutable"
	spaStaticCache    = "public, max-age=3600"
	spaRevalidate     = "no-cache"
)

// spaTypes pins content types so the answer does not depend on the host mime database
// (the Windows registry maps .js to text/plain on some machines).
var spaTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".json":        "application/json",
	".webmanifest": "application/manifest+json",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".ico":         "image/x-icon",
	".woff2":       "font/woff2",
	".map":         "application/json",
	".txt":         "text/plain; charset=utf-8",
}

// spaHandler serves the embedded single-page application.
type spaHandler struct {
	fsys      fs.FS
	index     []byte // nil when the frontend has not been built
	indexETag string
}

// NewSPAHandler serves fsys as a single-page application: hashed files under /assets are
// cached as immutable, index.html is always revalidated, and unknown extension-less paths
// fall back to index.html so client-side routes survive a reload.
func NewSPAHandler(fsys fs.FS) http.Handler {
	h := &spaHandler{fsys: fsys}
	if b, err := fs.ReadFile(fsys, spaIndex); err == nil {
		sum := sha256.Sum256(b)
		h.index = b
		h.indexETag = `"` + hex.EncodeToString(sum[:8]) + `"`
	}
	return h
}

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if p == "/api" || strings.HasPrefix(p, "/api/") {
		writeError(w, http.StatusNotFound, codeNotFound, "resource not found", nil)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeError(w, http.StatusMethodNotAllowed, codeMethodNotAllowed, "method not allowed", nil)
		return
	}

	name := strings.TrimPrefix(path.Clean("/"+p), "/")
	if name == "" || name == spaIndex {
		h.serveIndex(w, r)
		return
	}
	if h.serveFile(w, r, name) {
		return
	}
	// A missing asset or a file-like path is a real 404: answering with HTML would hide
	// broken deployments behind a MIME error in the browser.
	if strings.HasPrefix(p, "/"+spaAssetsPrefix) || path.Ext(name) != "" {
		writeError(w, http.StatusNotFound, codeNotFound, "resource not found", nil)
		return
	}
	h.serveIndex(w, r)
}

func (h *spaHandler) serveIndex(w http.ResponseWriter, r *http.Request) {
	if h.index == nil {
		http.Error(w, "frontend is not built into this binary", http.StatusServiceUnavailable)
		return
	}
	hd := w.Header()
	hd.Set("Content-Type", spaTypes[".html"])
	hd.Set("Cache-Control", spaRevalidate)
	hd.Set("ETag", h.indexETag)
	http.ServeContent(w, r, spaIndex, time.Time{}, bytes.NewReader(h.index))
}

// serveFile serves a regular file and reports whether it existed.
func (h *spaHandler) serveFile(w http.ResponseWriter, r *http.Request, name string) bool {
	f, err := h.fsys.Open(name)
	if err != nil {
		return false
	}
	defer func() { _ = f.Close() }()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		return false
	}
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		b, err := io.ReadAll(f)
		if err != nil {
			return false
		}
		rs = bytes.NewReader(b)
	}

	ext := path.Ext(name)
	ct, known := spaTypes[ext]
	if !known {
		ct = mime.TypeByExtension(ext)
	}
	hd := w.Header()
	if ct != "" {
		hd.Set("Content-Type", ct)
	}
	if strings.HasPrefix(name, spaAssetsPrefix) {
		hd.Set("Cache-Control", spaImmutableCache)
	} else {
		hd.Set("Cache-Control", spaStaticCache)
	}
	http.ServeContent(w, r, name, st.ModTime(), rs)
	return true
}
