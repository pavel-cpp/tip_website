package http

// Wiring (done by the lead in cmd/tipd/main.go and handler/http/server.go):
//
//	imgs := imaging.New(cfg.MaxImageMB<<20, cfg.MaxImagePixels)
//	blobs, _ := blobfs.New(cfg.DataDir, cfg.MinFreeDiskMB, cfg.UploadsMaxTotalMB)
//	projSvc := service.NewProjectService(service.ProjectsDeps{
//		Repo: postgres.NewProjectRepo(sqlDB), Blobs: blobs, Images: imgs,
//		Audit: <adapter to the audit service>, Events: <realtime hub or nil>,
//		Tx: txManager, Clock: clock, IDs: ids.UUIDv7{},
//	})
//	projects := httpapi.NewProjectsHandler(projSvc, int64(cfg.MaxImageMB)<<20)
//
// then embed *ProjectsHandler in the struct passed to gen.HandlerFromMux so its methods
// (ListProjects, CreateProject, GetProject, UpdateProject, DeleteProject, FinishProject,
// ReopenProject, GetProjectImage, PutProjectImage) win over gen.Unimplemented. A daily job
// should call ProjectService.CollectGarbage.

import (
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

// ProjectsService is the part of service.ProjectService used by the handlers.
type ProjectsService interface {
	List(ctx context.Context, a domain.Actor, f domain.ProjectFilter) ([]service.ProjectView, error)
	Create(ctx context.Context, a domain.Actor, title string) (service.ProjectView, error)
	Get(ctx context.Context, a domain.Actor, id string) (service.ProjectView, error)
	Update(ctx context.Context, a domain.Actor, id string, in service.UpdateProjectInput) (service.ProjectView, error)
	Finish(ctx context.Context, a domain.Actor, id string) (service.ProjectView, error)
	Reopen(ctx context.Context, a domain.Actor, id string) (service.ProjectView, error)
	Delete(ctx context.Context, a domain.Actor, id string) error
	PutImage(ctx context.Context, a domain.Actor, id, filename string, data []byte) (service.ProjectView, error)
	Image(ctx context.Context, a domain.Actor, id, ifNoneMatch string) (service.ImageFile, error)
}

// multipartOverhead is the allowance for multipart boundaries and headers on top of the file.
const multipartOverhead = 64 << 10

// imageCacheControl: image URLs carry ?v=<hash prefix>, so the content behind a URL never changes.
const imageCacheControl = "public, max-age=31536000, immutable"

// ProjectsHandler implements the project operations of gen.ServerInterface.
type ProjectsHandler struct {
	svc           ProjectsService
	maxImageBytes int64
}

// NewProjectsHandler returns the project endpoints; maxImageBytes bounds the uploaded file.
func NewProjectsHandler(svc ProjectsService, maxImageBytes int64) *ProjectsHandler {
	return &ProjectsHandler{svc: svc, maxImageBytes: maxImageBytes}
}

// ListProjects implements gen.ServerInterface.
func (h *ProjectsHandler) ListProjects(w http.ResponseWriter, r *http.Request, params gen.ListProjectsParams) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	f := domain.ProjectFilter{}
	if params.Status != nil {
		st := domain.ProjectStatus(*params.Status)
		f.Status = &st
	}
	if params.Q != nil {
		f.Query = *params.Q
	}
	views, err := h.svc.List(r.Context(), a, f)
	if err != nil {
		projectsFail(w, r, err)
		return
	}
	cards := make([]gen.ProjectCard, len(views))
	for i, v := range views {
		cards[i] = projectsCardDTO(v)
	}
	writeJSON(w, http.StatusOK, cards)
}

// CreateProject implements gen.ServerInterface.
func (h *ProjectsHandler) CreateProject(w http.ResponseWriter, r *http.Request) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	var req gen.CreateProjectRequest
	if err := decodeJSON(w, r, &req); err != nil {
		projectsFail(w, r, err)
		return
	}
	v, err := h.svc.Create(r.Context(), a, req.Title)
	if err != nil {
		projectsFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, gen.ProjectResponse{Project: projectsDTO(v)})
}

// GetProject implements gen.ServerInterface.
func (h *ProjectsHandler) GetProject(w http.ResponseWriter, r *http.Request, id gen.ProjectId) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	h.respond(w, r)(h.svc.Get(r.Context(), a, id.String()))
}

// UpdateProject implements gen.ServerInterface.
func (h *ProjectsHandler) UpdateProject(w http.ResponseWriter, r *http.Request, id gen.ProjectId) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	var req gen.UpdateProjectRequest
	if err := decodeJSON(w, r, &req); err != nil {
		projectsFail(w, r, err)
		return
	}
	if req.Version < 1 {
		projectsFail(w, r, domain.NewValidation(domain.FieldError{Field: "version", Reason: "must be a positive integer"}))
		return
	}
	in := service.UpdateProjectInput{Title: req.Title, Version: req.Version}
	if p := req.Placeholders; p != nil {
		in.Placeholders = &service.PlaceholdersPatch{
			Number: projectsPlaceholderPtr(p.Number),
			Name:   projectsPlaceholderPtr(p.Name),
			Phone:  projectsPlaceholderPtr(p.Phone),
		}
	}
	h.respond(w, r)(h.svc.Update(r.Context(), a, id.String(), in))
}

// DeleteProject implements gen.ServerInterface.
func (h *ProjectsHandler) DeleteProject(w http.ResponseWriter, r *http.Request, id gen.ProjectId) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	if err := h.svc.Delete(r.Context(), a, id.String()); err != nil {
		projectsFail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// FinishProject implements gen.ServerInterface.
func (h *ProjectsHandler) FinishProject(w http.ResponseWriter, r *http.Request, id gen.ProjectId) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	h.respond(w, r)(h.svc.Finish(r.Context(), a, id.String()))
}

// ReopenProject implements gen.ServerInterface.
func (h *ProjectsHandler) ReopenProject(w http.ResponseWriter, r *http.Request, id gen.ProjectId) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	h.respond(w, r)(h.svc.Reopen(r.Context(), a, id.String()))
}

// PutProjectImage implements gen.ServerInterface. The file is streamed from the multipart body
// with a hard size cap, so an oversized upload is rejected without buffering it.
func (h *ProjectsHandler) PutProjectImage(w http.ResponseWriter, r *http.Request, id gen.ProjectId) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	limit := h.maxImageBytes + multipartOverhead
	if r.ContentLength > limit {
		projectsFail(w, r, domain.ErrTooLarge)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	name, data, err := projectsReadFilePart(r, h.maxImageBytes)
	if err != nil {
		projectsFail(w, r, err)
		return
	}
	h.respond(w, r)(h.svc.PutImage(r.Context(), a, id.String(), name, data))
}

// projectsReadFilePart returns the name and content of the multipart field "file".
func projectsReadFilePart(r *http.Request, maxBytes int64) (string, []byte, error) {
	mr, err := r.MultipartReader()
	if err != nil {
		return "", nil, domain.NewValidation(domain.FieldError{Field: "body", Reason: "multipart/form-data body is required"})
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			return "", nil, domain.NewValidation(domain.FieldError{Field: "file", Reason: "file part is required"})
		}
		if err != nil {
			return "", nil, projectsBodyErr(err)
		}
		if part.FormName() != "file" {
			_ = part.Close()
			continue
		}
		return projectsReadPart(part, maxBytes)
	}
}

func projectsReadPart(part *multipart.Part, maxBytes int64) (string, []byte, error) {
	defer func() { _ = part.Close() }()
	data, err := io.ReadAll(io.LimitReader(part, maxBytes+1))
	if err != nil {
		return "", nil, projectsBodyErr(err)
	}
	if int64(len(data)) > maxBytes {
		return "", nil, domain.ErrTooLarge
	}
	if len(data) == 0 {
		return "", nil, domain.NewValidation(domain.FieldError{Field: "file", Reason: "file is empty"})
	}
	return part.FileName(), data, nil
}

// projectsBodyErr maps a body read failure onto 413 or 400.
func projectsBodyErr(err error) error {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return domain.ErrTooLarge
	}
	return domain.NewValidation(domain.FieldError{Field: "body", Reason: "malformed multipart body"})
}

// GetProjectImage implements gen.ServerInterface.
func (h *ProjectsHandler) GetProjectImage(w http.ResponseWriter, r *http.Request, id gen.ProjectId, params gen.GetProjectImageParams) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	inm := ""
	if params.IfNoneMatch != nil {
		inm = *params.IfNoneMatch
	}
	f, err := h.svc.Image(r.Context(), a, id.String(), inm)
	if err != nil {
		projectsFail(w, r, err)
		return
	}
	w.Header().Set("ETag", f.ETag())
	w.Header().Set("Cache-Control", imageCacheControl)
	if f.NotModified {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	defer func() { _ = f.Body.Close() }()
	w.Header().Set("Content-Type", f.Meta.Mime)
	// ServeContent adds Content-Length and range support; the zero modtime omits Last-Modified.
	http.ServeContent(w, r, "", time.Time{}, f.Body)
}

// respond returns a function that writes a ProjectResponse or the error.
func (h *ProjectsHandler) respond(w http.ResponseWriter, r *http.Request) func(service.ProjectView, error) {
	return func(v service.ProjectView, err error) {
		if err != nil {
			projectsFail(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, gen.ProjectResponse{Project: projectsDTO(v)})
	}
}

// projectsFail is fail with one addition: the current project in a VERSION_CONFLICT is rendered
// in its API shape instead of the service view.
func projectsFail(w http.ResponseWriter, r *http.Request, err error) {
	var de *domain.Error
	if errors.As(err, &de) && de.Code == domain.CodeVersionConflict {
		if cur, ok := de.Details["current"].(service.ProjectView); ok {
			err = domain.NewVersionConflict(projectsDTO(cur))
		}
	}
	fail(w, r, err)
}

func projectsPlaceholderPtr(p *gen.Placeholder) *domain.Placeholder {
	if p == nil {
		return nil
	}
	d := projectsPlaceholderFromDTO(*p)
	return &d
}

func projectsPlaceholderFromDTO(p gen.Placeholder) domain.Placeholder {
	return domain.Placeholder{
		Font: p.Font, Size: p.Size, Stroke: p.Stroke, Color: p.Color, StrokeColor: p.StrokeColor,
		Bold: p.Bold, Italic: p.Italic, Underline: p.Underline, X: p.X, Y: p.Y,
	}
}

func projectsPlaceholderDTO(p domain.Placeholder) gen.Placeholder {
	return gen.Placeholder{
		Font: p.Font, Size: p.Size, Stroke: p.Stroke, Color: p.Color, StrokeColor: p.StrokeColor,
		Bold: p.Bold, Italic: p.Italic, Underline: p.Underline, X: p.X, Y: p.Y,
	}
}

// projectsShortHash is the cache-busting version of an asset URL.
func projectsShortHash(sha string) string {
	if len(sha) > 8 {
		return sha[:8]
	}
	return sha
}

func projectsImageURL(id, sha string) string {
	return "/api/v1/projects/" + id + "/image?v=" + projectsShortHash(sha)
}

func projectsContributors(cs []domain.Contributor) []gen.UserRef {
	out := make([]gen.UserRef, len(cs))
	for i, c := range cs {
		ref := gen.UserRef{Id: uuid.MustParse(c.ID), DisplayName: c.DisplayName, Color: c.Color}
		if c.AvatarSHA != "" {
			u := "/api/v1/users/" + c.ID + "/avatar?v=" + projectsShortHash(c.AvatarSHA)
			ref.AvatarUrl = &u
		}
		out[i] = ref
	}
	return out
}

func projectsDTO(v service.ProjectView) gen.Project {
	out := gen.Project{
		Id:               uuid.MustParse(v.ID),
		Title:            v.Title,
		Status:           gen.ProjectStatus(v.Status),
		Version:          v.Version,
		CreatedAt:        v.CreatedAt,
		ParticipantCount: v.ParticipantCount,
		Contributors:     projectsContributors(v.Contributors),
		Placeholders: gen.Placeholders{
			Number: projectsPlaceholderDTO(v.Placeholders.Number),
			Name:   projectsPlaceholderDTO(v.Placeholders.Name),
			Phone:  projectsPlaceholderDTO(v.Placeholders.Phone),
		},
	}
	if v.Image != nil {
		out.Image = &gen.ProjectImage{
			Url: projectsImageURL(v.ID, v.Image.SHA256), Name: v.Image.Name,
			W: v.Image.Width, H: v.Image.Height, Bytes: v.Image.Bytes,
		}
	}
	return out
}

func projectsCardDTO(v service.ProjectView) gen.ProjectCard {
	out := gen.ProjectCard{
		Id:               uuid.MustParse(v.ID),
		Title:            v.Title,
		Status:           gen.ProjectStatus(v.Status),
		ParticipantCount: v.ParticipantCount,
		Contributors:     projectsContributors(v.Contributors),
	}
	if v.Image != nil {
		out.Image = &gen.CardImage{Url: projectsImageURL(v.ID, v.Image.SHA256)}
	}
	return out
}
