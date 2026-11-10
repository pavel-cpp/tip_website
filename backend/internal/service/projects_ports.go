package service

import (
	"context"
	"io"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// ProjectView is a project together with its contributors and participant count.
type ProjectView struct {
	domain.Project
	domain.ProjectDetails
}

// ProjectRepository is the persistence port of the projects service
// (implemented by repository/postgres).
type ProjectRepository interface {
	// Create inserts the project and its three placeholders.
	Create(ctx context.Context, p domain.Project) error
	// Get returns the project or domain.ErrNotFound.
	Get(ctx context.Context, id string) (domain.Project, error)
	// GetForUpdate is Get with a row lock; call it inside Tx.Do.
	GetForUpdate(ctx context.Context, id string) (domain.Project, error)
	// Save writes the mutable fields (title, status, image, placeholders, version) when the stored
	// version equals expectedVersion, and returns domain.ErrVersionConflict otherwise.
	Save(ctx context.Context, p domain.Project, expectedVersion int) error
	// Delete removes the project; domain.ErrNotFound when it does not exist.
	Delete(ctx context.Context, id string) error
	// List returns matching projects in the team order (see Reorder; new projects go first).
	List(ctx context.Context, f domain.ProjectFilter) ([]domain.Project, error)
	// Reorder gives the listed projects, in the listed order, the positions they occupy now.
	// Unknown and repeated ids are skipped; with activeOnly, finished projects are skipped too.
	// Call it inside Tx.Do.
	Reorder(ctx context.Context, ids []string, activeOnly bool) error
	// Details returns contributors (most recent first, at most maxContributors each) and
	// participant counts for the given projects.
	Details(ctx context.Context, ids []string, maxContributors int) (map[string]domain.ProjectDetails, error)
	// TouchContributor registers the user as a contributor or refreshes last_seen_at.
	TouchContributor(ctx context.Context, projectID, userID string, at time.Time) error
	// CountImageRefs returns how many projects reference the image hash.
	CountImageRefs(ctx context.Context, sha string) (int, error)
	// ReferencedImageHashes returns every image hash referenced by a project.
	ReferencedImageHashes(ctx context.Context) (map[string]struct{}, error)
}

// BlobStore is the file store port (implemented by repository/blobfs).
type BlobStore interface {
	// Put stores data under sha (or under domain.ThumbKey(sha) for a preview); domain.ErrDiskLow
	// when limits are exceeded.
	Put(ctx context.Context, sha string, data []byte) error
	// Open returns a reader or domain.ErrNotFound.
	Open(ctx context.Context, sha string) (io.ReadSeekCloser, error)
	// Delete removes the file; a missing file is not an error.
	Delete(ctx context.Context, sha string) error
	// GC removes unreferenced files older than the grace period.
	GC(ctx context.Context, referenced map[string]struct{}) (int, error)
}

// ImageProcessor validates and normalizes an uploaded image (implemented by platform/imaging).
// It returns domain.ErrUnsupportedMedia, domain.ErrTooLarge or domain.ErrImageInvalid.
type ImageProcessor interface {
	Normalize(data []byte) (out []byte, mime string, width, height int, err error)
	// Thumbnail returns a JPEG preview of the (already normalized) image, see domain.ThumbSide.
	Thumbnail(data []byte) ([]byte, error)
}

// ProjectAuditEntry is one auditable project action.
type ProjectAuditEntry struct {
	Actor     domain.Actor
	Action    string // project.create, project.reorder, project.update, project.finish, project.reopen, project.delete, image.upload
	ProjectID string
	// Meta carries ids and numbers only, never titles of people or other personal data.
	Meta map[string]any
}

// ProjectAudit records audit entries (implemented by the audit service).
type ProjectAudit interface {
	Record(ctx context.Context, e ProjectAuditEntry) error
}

// ProjectPresence reports who is connected to the realtime rooms right now
// (implemented by repository/memory.Hub). Projects with nobody online may be absent.
type ProjectPresence interface {
	Online(ctx context.Context, projectIDs []string) map[string][]domain.Peer
}

// ProjectEvents publishes realtime events of a project (implemented by the realtime hub).
type ProjectEvents interface {
	Publish(projectID string, ev domain.Event)
}
