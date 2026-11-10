package http

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

// FontsService is the part of service.FontService used by the handlers.
type FontsService interface {
	List(ctx context.Context, a domain.Actor) ([]domain.Font, error)
	Upload(ctx context.Context, a domain.Actor, name string, licenseConfirmed bool, data []byte) (domain.Font, error)
	Delete(ctx context.Context, a domain.Actor, id string) error
	File(ctx context.Context, a domain.Actor, id, ifNoneMatch string) (service.FontFile, error)
}

// fontsTextFieldMax bounds the small text parts of the upload form.
const fontsTextFieldMax = 1 << 10

// FontsHandler implements the font operations of gen.ServerInterface.
type FontsHandler struct{ svc FontsService }

// NewFontsHandler returns the font endpoints.
func NewFontsHandler(svc FontsService) *FontsHandler { return &FontsHandler{svc: svc} }

// ListFonts implements gen.ServerInterface.
func (h *FontsHandler) ListFonts(w http.ResponseWriter, r *http.Request) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	fonts, err := h.svc.List(r.Context(), a)
	if err != nil {
		fail(w, r, err)
		return
	}
	out := make([]gen.Font, len(fonts))
	for i, f := range fonts {
		out[i] = fontsDTO(f)
	}
	writeJSON(w, http.StatusOK, out)
}

// UploadFont implements gen.ServerInterface. The body is capped before it is buffered.
func (h *FontsHandler) UploadFont(w http.ResponseWriter, r *http.Request) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	limit := int64(domain.MaxFontBytes) + multipartOverhead
	if r.ContentLength > limit {
		fail(w, r, domain.ErrTooLarge)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	form, err := fontsReadForm(r)
	if err != nil {
		fail(w, r, err)
		return
	}
	f, err := h.svc.Upload(r.Context(), a, form.name, form.licenseConfirmed, form.data)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, fontsDTO(f))
}

// DeleteFont implements gen.ServerInterface.
func (h *FontsHandler) DeleteFont(w http.ResponseWriter, r *http.Request, id gen.FontId) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	if err := h.svc.Delete(r.Context(), a, id.String()); err != nil {
		fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetFontFile implements gen.ServerInterface.
func (h *FontsHandler) GetFontFile(w http.ResponseWriter, r *http.Request, id gen.FontId, params gen.GetFontFileParams) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	inm := ""
	if params.IfNoneMatch != nil {
		inm = *params.IfNoneMatch
	}
	f, err := h.svc.File(r.Context(), a, id.String(), inm)
	if err != nil {
		fail(w, r, err)
		return
	}
	w.Header().Set("ETag", f.ETag())
	w.Header().Set("Cache-Control", imageCacheControl)
	if f.NotModified {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	defer func() { _ = f.Body.Close() }()
	w.Header().Set("Content-Type", domain.FontMime(f.Font.Format))
	http.ServeContent(w, r, "", time.Time{}, f.Body)
}

type fontsForm struct {
	name             string
	licenseConfirmed bool
	data             []byte
}

// fontsReadForm reads the multipart fields file, name and licenseConfirmed in any order.
func fontsReadForm(r *http.Request) (fontsForm, error) {
	mr, err := r.MultipartReader()
	if err != nil {
		return fontsForm{}, domain.NewValidation(domain.FieldError{Field: "body", Reason: "multipart/form-data body is required"})
	}
	var form fontsForm
	haveFile := false
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fontsForm{}, projectsBodyErr(err)
		}
		switch field := part.FormName(); field {
		case "file":
			// projectsReadPart already returns domain errors (too large, empty, malformed).
			if _, form.data, err = projectsReadPart(part, domain.MaxFontBytes); err != nil {
				return fontsForm{}, err
			}
			haveFile = true
		case "name", "licenseConfirmed":
			b, err := io.ReadAll(io.LimitReader(part, fontsTextFieldMax))
			_ = part.Close()
			if err != nil {
				return fontsForm{}, projectsBodyErr(err)
			}
			if field == "name" {
				form.name = string(b)
			} else {
				form.licenseConfirmed = string(b) == "true"
			}
		default:
			_ = part.Close()
		}
	}
	if !haveFile {
		return fontsForm{}, domain.NewValidation(domain.FieldError{Field: "file", Reason: "file part is required"})
	}
	return form, nil
}

func fontsDTO(f domain.Font) gen.Font {
	return gen.Font{
		Id: uuid.MustParse(f.ID), Name: f.Name, Format: gen.FontFormat(f.Format), Bytes: f.Bytes,
		Url:       "/api/v1/fonts/" + f.ID + "/file?v=" + projectsShortHash(f.SHA256),
		CreatedAt: f.CreatedAt,
	}
}
