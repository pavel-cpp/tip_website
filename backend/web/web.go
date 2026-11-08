// Package web embeds the built single-page application (frontend/dist copied to
// backend/web/dist by the Docker build or `task`). A tracked .gitkeep keeps the embed
// pattern valid, so the backend compiles even when the SPA has not been built.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// FS returns the SPA files rooted at the dist directory (index.html at the top level).
// It holds no index.html when the frontend has not been built.
func FS() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		// Unreachable: the "dist" directory is guaranteed by the embed pattern.
		panic("web: embedded dist directory missing: " + err.Error())
	}
	return sub
}
