package http

import (
	"errors"
	"mime"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

// Multipart overhead allowed on top of the file limit (boundaries and the mode field), and
// the in-memory part of the form; larger parts spill to temporary files.
const (
	importBodyOverhead = 1 << 20
	importFormMemory   = 4 << 20
)

func participantsParseUUID(s string) uuid.UUID {
	id, _ := uuid.Parse(s) // ids come from the database; a malformed one yields the nil UUID
	return id
}

// ExportParticipantsXlsx handles GET /projects/{id}/export.xlsx.
func (h *ParticipantsHandler) ExportParticipantsXlsx(w http.ResponseWriter, r *http.Request, id gen.ProjectId) {
	h.export(w, r, id.String(), service.FormatXLSX)
}

// ExportParticipantsCsv handles GET /projects/{id}/export.csv.
func (h *ParticipantsHandler) ExportParticipantsCsv(w http.ResponseWriter, r *http.Request, id gen.ProjectId) {
	h.export(w, r, id.String(), service.FormatCSV)
}

func (h *ParticipantsHandler) export(w http.ResponseWriter, r *http.Request, projectID, format string) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	file, err := h.svc.Export(r.Context(), a, projectID, format)
	if err != nil {
		participantsFail(w, r, err)
		return
	}
	w.Header().Set("Content-Type", file.ContentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": file.Filename}))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if err := file.WriteTo(w); err != nil {
		// Headers are already sent; the truncated body signals the failure to the client.
		fail(w, r, err)
	}
}

// ImportParticipants handles POST /projects/{id}/participants/import (multipart).
func (h *ParticipantsHandler) ImportParticipants(w http.ResponseWriter, r *http.Request, id gen.ProjectId, params gen.ImportParticipantsParams) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, service.MaxImportBytes+importBodyOverhead)
	if err := r.ParseMultipartForm(importFormMemory); err != nil {
		participantsFail(w, r, importFormError(err))
		return
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()

	file, header, err := r.FormFile("file")
	if err != nil {
		participantsFail(w, r, domain.NewValidation(domain.FieldError{Field: "file", Reason: "is required"}))
		return
	}
	defer func() { _ = file.Close() }()
	if header.Size > service.MaxImportBytes {
		participantsFail(w, r, domain.ErrTooLarge)
		return
	}

	res, err := h.svc.Import(r.Context(), a, service.ImportInput{
		ProjectID: id.String(),
		Mode:      r.FormValue("mode"),
		DryRun:    params.DryRun != nil && *params.DryRun,
		File:      file,
	})
	if err != nil {
		participantsFail(w, r, err)
		return
	}
	out := gen.ImportResult{
		DryRun: res.DryRun, Mode: gen.ImportResultMode(res.Mode), Total: res.Total, Valid: res.Valid,
		Imported: res.Imported, Errors: make([]gen.ImportRowError, len(res.Errors)),
	}
	for i, e := range res.Errors {
		out.Errors[i] = gen.ImportRowError{Row: e.Row, Field: gen.ImportRowErrorField(e.Field), Code: e.Code, Message: e.Message}
	}
	writeJSON(w, http.StatusOK, out)
}

func importFormError(err error) error {
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		return domain.ErrTooLarge
	case errors.Is(err, http.ErrNotMultipart), strings.Contains(err.Error(), "multipart"):
		return domain.NewValidation(domain.FieldError{Field: "body", Reason: "multipart/form-data is required"})
	default:
		return domain.NewValidation(domain.FieldError{Field: "body", Reason: "malformed multipart body"})
	}
}
