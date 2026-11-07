package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// Contributor list sizes: the card shows a few avatars, the project page shows more.
const (
	cardContributors   = 5
	detailContributors = 50
)

// Audit action names written by the projects service.
const (
	ActionProjectCreate = "project.create"
	ActionProjectUpdate = "project.update"
	ActionProjectFinish = "project.finish"
	ActionProjectReopen = "project.reopen"
	ActionProjectDelete = "project.delete"
	ActionImageUpload   = "image.upload"
)

// ProjectsDeps are the collaborators of ProjectService. Events may be nil.
type ProjectsDeps struct {
	Repo   ProjectRepository
	Blobs  BlobStore
	Images ImageProcessor
	Audit  ProjectAudit
	Events ProjectEvents
	Tx     Tx
	Clock  Clock
	IDs    IDGen
}

// ProjectService implements the project use cases. Authorization is decided from the
// permissions carried by the actor; there are no database lookups for it.
type ProjectService struct{ d ProjectsDeps }

// NewProjectService builds the service.
func NewProjectService(d ProjectsDeps) *ProjectService { return &ProjectService{d: d} }

// PlaceholdersPatch replaces the placeholders that are non-nil.
type PlaceholdersPatch struct {
	Number, Name, Phone *domain.Placeholder
}

// UpdateProjectInput is the PATCH payload.
type UpdateProjectInput struct {
	Title        *string
	Placeholders *PlaceholdersPatch
	// Version is the version the client based its edit on.
	Version int
}

// ImageFile is the result of an image download.
type ImageFile struct {
	Meta domain.ImageMeta
	// NotModified is set when the caller's ETag matched; Body is nil then.
	NotModified bool
	Body        io.ReadSeekCloser
}

// ETag returns the strong entity tag of the image (the content hash, quoted).
func (f ImageFile) ETag() string { return `"` + f.Meta.SHA256 + `"` }

// hidden maps a finished project the actor may not see onto NOT_FOUND so its existence is not
// disclosed.
func hidden(a domain.Actor, p domain.Project) error {
	if p.IsFinished() && !a.Can(domain.PermProjectViewFinished) {
		return domain.ErrNotFound
	}
	return nil
}

// List returns the projects visible to the actor. Finished projects need
// project.view_finished: asking for them explicitly without it is FORBIDDEN, and an
// unfiltered list silently omits them.
func (s *ProjectService) List(ctx context.Context, a domain.Actor, f ProjectFilter) ([]ProjectView, error) {
	if err := a.Require(domain.PermProjectView); err != nil {
		return nil, err
	}
	if f.Status != nil && *f.Status != domain.ProjectActive && *f.Status != domain.ProjectFinished {
		return nil, domain.NewValidation(domain.FieldError{Field: "status", Reason: "unknown status"})
	}
	f.Query = strings.TrimSpace(f.Query)
	if utf8.RuneCountInString(f.Query) > domain.MaxTitleLen {
		return nil, domain.NewValidation(domain.FieldError{Field: "q", Reason: "must be at most 120 characters"})
	}
	if !a.Can(domain.PermProjectViewFinished) {
		if f.Status != nil && *f.Status == domain.ProjectFinished {
			return nil, domain.ErrForbidden
		}
		active := domain.ProjectActive
		f.Status = &active
	}
	projects, err := s.d.Repo.List(ctx, f)
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	return s.withDetails(ctx, projects, cardContributors)
}

func (s *ProjectService) withDetails(ctx context.Context, projects []domain.Project, maxContributors int) ([]ProjectView, error) {
	ids := make([]string, len(projects))
	for i, p := range projects {
		ids[i] = p.ID
	}
	details := map[string]ProjectDetails{}
	if len(ids) > 0 {
		var err error
		if details, err = s.d.Repo.Details(ctx, ids, maxContributors); err != nil {
			return nil, fmt.Errorf("load project details: %w", err)
		}
	}
	out := make([]ProjectView, len(projects))
	for i, p := range projects {
		out[i] = ProjectView{Project: p, ProjectDetails: details[p.ID]}
	}
	return out, nil
}

func (s *ProjectService) view(ctx context.Context, p domain.Project) (ProjectView, error) {
	vs, err := s.withDetails(ctx, []domain.Project{p}, detailContributors)
	if err != nil {
		return ProjectView{}, err
	}
	return vs[0], nil
}

func (s *ProjectService) audit(ctx context.Context, a domain.Actor, action, projectID string, meta map[string]any) error {
	if s.d.Audit == nil {
		return nil
	}
	if err := s.d.Audit.Record(ctx, ProjectAuditEntry{Actor: a, Action: action, ProjectID: projectID, Meta: meta}); err != nil {
		return fmt.Errorf("record audit %s: %w", action, err)
	}
	return nil
}

func (s *ProjectService) publish(p domain.Project) {
	if s.d.Events != nil {
		s.d.Events.Publish(p.ID, domain.ProjectUpdated(p))
	}
}

// Create makes a new active project with default placeholders.
func (s *ProjectService) Create(ctx context.Context, a domain.Actor, title string) (ProjectView, error) {
	if err := a.Require(domain.PermProjectCreate); err != nil {
		return ProjectView{}, err
	}
	title, err := domain.ValidateTitle(title)
	if err != nil {
		return ProjectView{}, err
	}
	now := s.d.Clock.Now()
	p := domain.Project{
		ID:           s.d.IDs.NewID(),
		Title:        title,
		Status:       domain.ProjectActive,
		Placeholders: domain.DefaultPlaceholders(0, 0),
		NextNumber:   1,
		Version:      1,
		CreatedBy:    a.UserID,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	err = s.d.Tx.Do(ctx, func(ctx context.Context) error {
		if err := s.d.Repo.Create(ctx, p); err != nil {
			return fmt.Errorf("create project: %w", err)
		}
		return s.audit(ctx, a, ActionProjectCreate, p.ID, nil)
	})
	if err != nil {
		return ProjectView{}, err
	}
	return s.view(ctx, p)
}

// Get returns a project and registers the actor as its contributor.
func (s *ProjectService) Get(ctx context.Context, a domain.Actor, id string) (ProjectView, error) {
	if err := a.Require(domain.PermProjectView); err != nil {
		return ProjectView{}, err
	}
	p, err := s.d.Repo.Get(ctx, id)
	if err != nil {
		return ProjectView{}, err
	}
	if err := hidden(a, p); err != nil {
		return ProjectView{}, err
	}
	if err := s.d.Repo.TouchContributor(ctx, id, a.UserID, s.d.Clock.Now()); err != nil {
		return ProjectView{}, fmt.Errorf("register contributor: %w", err)
	}
	return s.view(ctx, p)
}

// load fetches a project for a write: it applies the visibility rule first so a hidden project
// stays NOT_FOUND, then the read-only guard.
func (s *ProjectService) lockWritable(ctx context.Context, a domain.Actor, id string) (domain.Project, error) {
	p, err := s.d.Repo.GetForUpdate(ctx, id)
	if err != nil {
		return domain.Project{}, err
	}
	if err := hidden(a, p); err != nil {
		return domain.Project{}, err
	}
	if err := p.EnsureWritable(); err != nil {
		return domain.Project{}, err
	}
	return p, nil
}

func (s *ProjectService) conflict(ctx context.Context, id string) error {
	cur, err := s.d.Repo.Get(ctx, id)
	if err != nil {
		return err
	}
	v, err := s.view(ctx, cur)
	if err != nil {
		return err
	}
	return domain.NewVersionConflict(v)
}

// save persists p (already carrying the incremented version) guarded by the previous version.
func (s *ProjectService) save(ctx context.Context, p domain.Project) error {
	if err := s.d.Repo.Save(ctx, p, p.Version-1); err != nil {
		if errors.Is(err, domain.ErrVersionConflict) {
			return s.conflict(ctx, p.ID)
		}
		return fmt.Errorf("save project: %w", err)
	}
	return nil
}

// Update changes the title and/or placeholders using optimistic concurrency.
func (s *ProjectService) Update(ctx context.Context, a domain.Actor, id string, in UpdateProjectInput) (ProjectView, error) {
	if err := a.Require(domain.PermProjectUpdate); err != nil {
		return ProjectView{}, err
	}
	hasPatch := in.Placeholders != nil &&
		(in.Placeholders.Number != nil || in.Placeholders.Name != nil || in.Placeholders.Phone != nil)
	if in.Title == nil && !hasPatch {
		return ProjectView{}, domain.NewValidation(domain.FieldError{Field: "body", Reason: "nothing to update"})
	}
	var title string
	if in.Title != nil {
		t, err := domain.ValidateTitle(*in.Title)
		if err != nil {
			return ProjectView{}, err
		}
		title = t
	}

	var updated domain.Project
	err := s.d.Tx.Do(ctx, func(ctx context.Context) error {
		p, err := s.lockWritable(ctx, a, id)
		if err != nil {
			return err
		}
		if in.Version != p.Version {
			return s.conflict(ctx, id)
		}
		if in.Title != nil {
			p.Title = title
		}
		if hasPatch {
			if in.Placeholders.Number != nil {
				p.Placeholders.Number = *in.Placeholders.Number
			}
			if in.Placeholders.Name != nil {
				p.Placeholders.Name = *in.Placeholders.Name
			}
			if in.Placeholders.Phone != nil {
				p.Placeholders.Phone = *in.Placeholders.Phone
			}
			if err := p.Placeholders.Validate(); err != nil {
				return err
			}
		}
		p.Version++
		p.UpdatedAt = s.d.Clock.Now()
		if err := s.save(ctx, p); err != nil {
			return err
		}
		updated = p
		return s.audit(ctx, a, ActionProjectUpdate, id, map[string]any{"version": p.Version})
	})
	if err != nil {
		return ProjectView{}, err
	}
	s.publish(updated)
	return s.view(ctx, updated)
}

// Finish makes the project read-only.
func (s *ProjectService) Finish(ctx context.Context, a domain.Actor, id string) (ProjectView, error) {
	return s.transition(ctx, a, id, ActionProjectFinish, func(p domain.Project) (domain.Project, error) {
		return p.Finish(s.d.Clock.Now())
	})
}

// Reopen returns a finished project to the active state.
func (s *ProjectService) Reopen(ctx context.Context, a domain.Actor, id string) (ProjectView, error) {
	return s.transition(ctx, a, id, ActionProjectReopen, func(p domain.Project) (domain.Project, error) {
		return p.Reopen(s.d.Clock.Now())
	})
}

func (s *ProjectService) transition(ctx context.Context, a domain.Actor, id, action string, f func(domain.Project) (domain.Project, error)) (ProjectView, error) {
	if err := a.Require(domain.PermProjectFinish); err != nil {
		return ProjectView{}, err
	}
	var out domain.Project
	err := s.d.Tx.Do(ctx, func(ctx context.Context) error {
		p, err := s.d.Repo.GetForUpdate(ctx, id)
		if err != nil {
			return err
		}
		if err := hidden(a, p); err != nil {
			return err
		}
		next, err := f(p)
		if err != nil {
			return err
		}
		if err := s.save(ctx, next); err != nil {
			return err
		}
		out = next
		return s.audit(ctx, a, action, id, map[string]any{"version": next.Version})
	})
	if err != nil {
		return ProjectView{}, err
	}
	s.publish(out)
	return s.view(ctx, out)
}

// Delete removes a project and its image file when no other project shares the file.
func (s *ProjectService) Delete(ctx context.Context, a domain.Actor, id string) error {
	if err := a.Require(domain.PermProjectDelete); err != nil {
		return err
	}
	var sha string
	err := s.d.Tx.Do(ctx, func(ctx context.Context) error {
		p, err := s.d.Repo.GetForUpdate(ctx, id)
		if err != nil {
			return err
		}
		if err := hidden(a, p); err != nil {
			return err
		}
		if err := s.d.Repo.Delete(ctx, id); err != nil {
			return err
		}
		if p.Image != nil {
			sha = p.Image.SHA256
		}
		return s.audit(ctx, a, ActionProjectDelete, id, nil)
	})
	if err != nil {
		return err
	}
	// The file removal happens after the commit; a failure only leaves an orphan for the GC.
	s.dropBlobIfOrphan(ctx, sha)
	return nil
}

func (s *ProjectService) dropBlobIfOrphan(ctx context.Context, sha string) {
	if sha == "" {
		return
	}
	n, err := s.d.Repo.CountImageRefs(ctx, sha)
	if err != nil || n > 0 {
		return
	}
	_ = s.d.Blobs.Delete(ctx, sha) // best effort: the GC removes what is left behind
}

// PutImage validates, normalizes and stores a replacement ticket image.
func (s *ProjectService) PutImage(ctx context.Context, a domain.Actor, id, filename string, data []byte) (ProjectView, error) {
	if err := a.Require(domain.PermProjectUpdate); err != nil {
		return ProjectView{}, err
	}
	// Cheap pre-check so a read-only or hidden project does not cost an image decode.
	cur, err := s.d.Repo.Get(ctx, id)
	if err != nil {
		return ProjectView{}, err
	}
	if err := hidden(a, cur); err != nil {
		return ProjectView{}, err
	}
	if err := cur.EnsureWritable(); err != nil {
		return ProjectView{}, err
	}

	out, mime, w, h, err := s.d.Images.Normalize(data)
	if err != nil {
		return ProjectView{}, err
	}
	sum := sha256.Sum256(out)
	meta := domain.ImageMeta{
		SHA256: hex.EncodeToString(sum[:]),
		Name:   cleanFileName(filename, mime),
		Mime:   mime,
		Width:  w,
		Height: h,
		Bytes:  len(out),
	}
	if err := meta.Validate(); err != nil {
		return ProjectView{}, err
	}
	if err := s.d.Blobs.Put(ctx, meta.SHA256, out); err != nil {
		return ProjectView{}, err
	}

	var updated domain.Project
	var oldSHA string
	err = s.d.Tx.Do(ctx, func(ctx context.Context) error {
		p, err := s.lockWritable(ctx, a, id)
		if err != nil {
			return err
		}
		ps, err := rescalePlaceholders(p, meta)
		if err != nil {
			return err
		}
		if p.Image != nil {
			oldSHA = p.Image.SHA256
		}
		p.Image = &meta
		p.Placeholders = ps
		p.Version++
		p.UpdatedAt = s.d.Clock.Now()
		if err := s.save(ctx, p); err != nil {
			return err
		}
		updated = p
		return s.audit(ctx, a, ActionImageUpload, id, map[string]any{
			"sha256": meta.SHA256, "bytes": meta.Bytes, "width": meta.Width, "height": meta.Height,
		})
	})
	if err != nil {
		return ProjectView{}, err
	}
	if oldSHA != "" && oldSHA != meta.SHA256 {
		s.dropBlobIfOrphan(ctx, oldSHA)
	}
	s.publish(updated)
	return s.view(ctx, updated)
}

// rescalePlaceholders adapts the placeholders to the new image. The very first image of a
// project that still has untouched default placeholders gets defaults computed from the image
// size; otherwise positions and sizes are scaled from the previous canvas.
func rescalePlaceholders(p domain.Project, m domain.ImageMeta) (domain.Placeholders, error) {
	if p.Image == nil {
		if p.Placeholders == domain.DefaultPlaceholders(0, 0) {
			return domain.DefaultPlaceholders(m.Width, m.Height), nil
		}
		// No previous image: placeholders were laid out on the default canvas
		// (domain.DefaultPlaceholders(0, 0) uses 1024x768).
		return p.Placeholders.Rescaled(1024, 768, m.Width, m.Height)
	}
	if p.Image.Width == m.Width && p.Image.Height == m.Height {
		return p.Placeholders, nil
	}
	return p.Placeholders.Rescaled(p.Image.Width, p.Image.Height, m.Width, m.Height)
}

// cleanFileName reduces an uploaded file name to a safe base name of at most 255 characters.
func cleanFileName(name, mime string) string {
	name = strings.ReplaceAll(name, `\`, "/")
	name = path.Base(name)
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." || name == "/" {
		if mime == "image/png" {
			return "image.png"
		}
		return "image.jpg"
	}
	if utf8.RuneCountInString(name) > 255 {
		name = string([]rune(name)[:255])
	}
	return name
}

// Image returns the original image of a project for download. When etag (the If-None-Match
// value) matches the content hash, Body is nil and NotModified is set.
func (s *ProjectService) Image(ctx context.Context, a domain.Actor, id, ifNoneMatch string) (ImageFile, error) {
	if err := a.Require(domain.PermProjectView); err != nil {
		return ImageFile{}, err
	}
	p, err := s.d.Repo.Get(ctx, id)
	if err != nil {
		return ImageFile{}, err
	}
	if err := hidden(a, p); err != nil {
		return ImageFile{}, err
	}
	if p.Image == nil {
		return ImageFile{}, domain.ErrNotFound
	}
	f := ImageFile{Meta: *p.Image}
	if etagMatches(ifNoneMatch, f.ETag()) {
		f.NotModified = true
		return f, nil
	}
	body, err := s.d.Blobs.Open(ctx, p.Image.SHA256)
	if err != nil {
		return ImageFile{}, err
	}
	f.Body = body
	return f, nil
}

// etagMatches implements the weak comparison of If-None-Match for a strong tag.
func etagMatches(header, etag string) bool {
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(part)
		if part == "*" || strings.TrimPrefix(part, "W/") == etag {
			return true
		}
	}
	return false
}

// CollectGarbage removes image files that no project references and that are old enough.
func (s *ProjectService) CollectGarbage(ctx context.Context) (int, error) {
	refs, err := s.d.Repo.ReferencedImageHashes(ctx)
	if err != nil {
		return 0, fmt.Errorf("list referenced images: %w", err)
	}
	return s.d.Blobs.GC(ctx, refs)
}
