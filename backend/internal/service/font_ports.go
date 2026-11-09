package service

import (
	"context"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// FontRepository is the persistence port of the fonts service (implemented by repository/postgres).
type FontRepository interface {
	// Create inserts the font; the service checks GetBySHA first so a duplicate upload is idempotent.
	Create(ctx context.Context, f domain.Font) error
	// List returns every uploaded font, newest first.
	List(ctx context.Context) ([]domain.Font, error)
	// Get returns the font or domain.ErrNotFound.
	Get(ctx context.Context, id string) (domain.Font, error)
	// GetBySHA returns the font with that content hash or domain.ErrNotFound.
	GetBySHA(ctx context.Context, sha string) (domain.Font, error)
	// Delete removes the font; domain.ErrNotFound when it does not exist.
	Delete(ctx context.Context, id string) error
	// Usage returns how many fonts are stored and their total size in bytes.
	Usage(ctx context.Context) (count int, bytes int64, err error)
	// InUse reports whether a project placeholder uses the font.
	InUse(ctx context.Context, id string) (bool, error)
	ProjectFonts
}

// ProjectFonts is what the projects service needs from the font store: validating references in
// placeholders and keeping font files out of the blob garbage collector. A nil ProjectFonts
// disables custom fonts in the projects service.
type ProjectFonts interface {
	// Exists reports whether an uploaded font with that id exists.
	Exists(ctx context.Context, id string) (bool, error)
	// Hashes returns the content hash of every uploaded font.
	Hashes(ctx context.Context) (map[string]struct{}, error)
}
