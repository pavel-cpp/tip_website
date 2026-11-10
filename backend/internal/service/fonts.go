package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// Audit action names written by the fonts service.
const (
	ActionFontUpload = "font.upload"
	ActionFontDelete = "font.delete"
)

// FontsDeps are the collaborators of FontService.
type FontsDeps struct {
	Repo  FontRepository
	Blobs BlobStore
	Audit ProjectAudit
	Tx    Tx
	Clock Clock
	IDs   IDGen
}

// FontService manages uploaded ticket fonts. Reading needs project.view (workers render tickets
// with them); uploading and deleting need project.update, like the other ticket settings.
type FontService struct{ d FontsDeps }

// NewFontService builds the service.
func NewFontService(d FontsDeps) *FontService { return &FontService{d: d} }

// FontFile is the result of a font download.
type FontFile struct {
	Font domain.Font
	// NotModified is set when the caller's ETag matched; Body is nil then.
	NotModified bool
	Body        io.ReadSeekCloser
}

// ETag returns the strong entity tag of the file (the content hash, quoted).
func (f FontFile) ETag() string { return `"` + f.Font.SHA256 + `"` }

// List returns the uploaded fonts, newest first.
func (s *FontService) List(ctx context.Context, a domain.Actor) ([]domain.Font, error) {
	if err := a.Require(domain.PermProjectView); err != nil {
		return nil, err
	}
	fonts, err := s.d.Repo.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list fonts: %w", err)
	}
	return fonts, nil
}

// Upload validates and stores a font. Uploading the same file twice returns the existing font.
// licenseConfirmed records that the operator confirmed the right to use and embed the font.
func (s *FontService) Upload(ctx context.Context, a domain.Actor, name string, licenseConfirmed bool, data []byte) (domain.Font, error) {
	if err := a.Require(domain.PermProjectUpdate); err != nil {
		return domain.Font{}, err
	}
	if !licenseConfirmed {
		return domain.Font{}, domain.NewValidation(domain.FieldError{Field: "licenseConfirmed", Reason: "the licence must be confirmed"})
	}
	name, err := domain.ValidateFontName(name)
	if err != nil {
		return domain.Font{}, err
	}
	if len(data) > domain.MaxFontBytes {
		return domain.Font{}, domain.ErrTooLarge
	}
	format := domain.DetectFontFormat(data)
	if format == "" {
		return domain.Font{}, domain.ErrUnsupportedMedia
	}
	sum := sha256.Sum256(data)
	sha := hex.EncodeToString(sum[:])

	var out domain.Font
	err = s.d.Tx.Do(ctx, func(ctx context.Context) error {
		if existing, err := s.d.Repo.GetBySHA(ctx, sha); err == nil {
			out = existing
			return nil
		} else if !errors.Is(err, domain.ErrNotFound) {
			return fmt.Errorf("find font: %w", err)
		}
		count, total, err := s.d.Repo.Usage(ctx)
		if err != nil {
			return fmt.Errorf("font usage: %w", err)
		}
		if count >= domain.MaxFontCount || total+int64(len(data)) > domain.MaxFontsTotal {
			return domain.NewValidation(domain.FieldError{Field: "file", Reason: "font storage quota exceeded"})
		}
		if err := s.d.Blobs.Put(ctx, sha, data); err != nil {
			return err
		}
		f := domain.Font{
			ID: s.d.IDs.NewID(), Name: name, Format: format, SHA256: sha, Bytes: len(data),
			CreatedBy: a.UserID, CreatedAt: s.d.Clock.Now(),
		}
		if err := s.d.Repo.Create(ctx, f); err != nil {
			return fmt.Errorf("create font: %w", err)
		}
		out = f
		return s.audit(ctx, a, ActionFontUpload, map[string]any{
			"fontId": f.ID, "sha256": sha, "bytes": f.Bytes, "format": format,
		})
	})
	if err != nil {
		return domain.Font{}, err
	}
	return out, nil
}

// Delete removes an uploaded font that no project uses.
func (s *FontService) Delete(ctx context.Context, a domain.Actor, id string) error {
	if err := a.Require(domain.PermProjectUpdate); err != nil {
		return err
	}
	var sha string
	err := s.d.Tx.Do(ctx, func(ctx context.Context) error {
		f, err := s.d.Repo.Get(ctx, id)
		if err != nil {
			return err
		}
		used, err := s.d.Repo.InUse(ctx, id)
		if err != nil {
			return fmt.Errorf("check font usage: %w", err)
		}
		if used {
			return domain.NewValidation(domain.FieldError{Field: "id", Reason: "the font is used by a project"})
		}
		if err := s.d.Repo.Delete(ctx, id); err != nil {
			return err
		}
		sha = f.SHA256
		return s.audit(ctx, a, ActionFontDelete, map[string]any{"fontId": id, "sha256": sha})
	})
	if err != nil {
		return err
	}
	// Best effort after the commit: the blob GC removes what is left behind.
	_ = s.d.Blobs.Delete(ctx, sha)
	return nil
}

// File returns the font file for download; when ifNoneMatch matches, Body is nil and NotModified is set.
func (s *FontService) File(ctx context.Context, a domain.Actor, id, ifNoneMatch string) (FontFile, error) {
	if err := a.Require(domain.PermProjectView); err != nil {
		return FontFile{}, err
	}
	f, err := s.d.Repo.Get(ctx, id)
	if err != nil {
		return FontFile{}, err
	}
	out := FontFile{Font: f}
	if etagMatches(ifNoneMatch, out.ETag()) {
		out.NotModified = true
		return out, nil
	}
	body, err := s.d.Blobs.Open(ctx, f.SHA256)
	if err != nil {
		return FontFile{}, err
	}
	out.Body = body
	return out, nil
}

func (s *FontService) audit(ctx context.Context, a domain.Actor, action string, meta map[string]any) error {
	if s.d.Audit == nil {
		return nil
	}
	if err := s.d.Audit.Record(ctx, ProjectAuditEntry{Actor: a, Action: action, Meta: meta}); err != nil {
		return fmt.Errorf("record audit: %w", err)
	}
	return nil
}
