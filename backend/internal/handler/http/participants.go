package http

// Registration (done by the lead in cmd/tipd/main.go and handler/http/server.go):
//
//	ph := NewParticipantsHandler(participantsSvc) // *service.Participants
//	ah := NewAuditHandler(auditSvc)               // *service.Audit
//
// Embed *ParticipantsHandler and *AuditHandler in the composite gen.ServerInterface
// implementation at a shallower depth than gen.Unimplemented so their methods win. The
// ParticipantsHandler serves list/create/update/delete/clear/printed (this file) and import
// and export (exportimport.go); the AuditHandler serves GET /admin/audit (audit.go).

import (
	"context"
	"errors"
	"net/http"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

// participantsAPI is the part of *service.Participants the handler uses.
type participantsAPI interface {
	List(ctx context.Context, a domain.Actor, in service.ListInput) (service.ParticipantList, error)
	Add(ctx context.Context, a domain.Actor, in service.AddInput) ([]domain.Participant, error)
	Update(ctx context.Context, a domain.Actor, in service.UpdateInput) (domain.Participant, error)
	Delete(ctx context.Context, a domain.Actor, projectID string, ids []string) (int, error)
	Clear(ctx context.Context, a domain.Actor, projectID, confirmTitle string) (int, error)
	LogPrinted(ctx context.Context, a domain.Actor, projectID string, ids []string) error
	Export(ctx context.Context, a domain.Actor, projectID, format string) (service.ExportFile, error)
	Import(ctx context.Context, a domain.Actor, in service.ImportInput) (service.ImportResult, error)
}

// ParticipantsHandler implements the participant, import and export operations of gen.ServerInterface.
type ParticipantsHandler struct{ svc participantsAPI }

// NewParticipantsHandler returns the handler over the participants service.
func NewParticipantsHandler(svc participantsAPI) *ParticipantsHandler {
	return &ParticipantsHandler{svc: svc}
}

func participantsToDTO(p domain.Participant) gen.Participant {
	return gen.Participant{
		Id:        participantsParseUUID(p.ID),
		ProjectId: participantsParseUUID(p.ProjectID),
		Number:    p.Number,
		Name:      p.Name,
		Phone:     p.Phone,
		Version:   p.Version,
		UpdatedAt: p.UpdatedAt.UTC().Truncate(time.Microsecond),
	}
}

func participantsItemsDTO(rows []domain.Participant) []gen.Participant {
	out := make([]gen.Participant, len(rows))
	for i, p := range rows {
		out[i] = participantsToDTO(p)
	}
	return out
}

func participantsIDs(in []openapi_types.UUID) []string {
	out := make([]string, len(in))
	for i, id := range in {
		out[i] = id.String()
	}
	return out
}

// participantsFail is fail with one addition: the row carried by a VERSION_CONFLICT is a
// domain value, so it is converted to the Participant DTO before it reaches the client.
func participantsFail(w http.ResponseWriter, r *http.Request, err error) {
	var de *domain.Error
	if errors.As(err, &de) && de.Code == domain.CodeVersionConflict {
		if cur, ok := de.Details["current"].(domain.Participant); ok {
			err = domain.NewVersionConflict(participantsToDTO(cur))
		}
	}
	fail(w, r, err)
}

// ListParticipants handles GET /projects/{id}/participants.
func (h *ParticipantsHandler) ListParticipants(w http.ResponseWriter, r *http.Request, id gen.ProjectId, params gen.ListParticipantsParams) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	in := service.ListInput{ProjectID: id.String()}
	if params.Q != nil {
		in.Query = *params.Q
	}
	if params.IfNoneMatch != nil {
		in.IfNoneMatch = *params.IfNoneMatch
	}
	res, err := h.svc.List(r.Context(), a, in)
	if err != nil {
		participantsFail(w, r, err)
		return
	}
	w.Header().Set("ETag", res.ETag)
	w.Header().Set("Cache-Control", "private, no-cache")
	if res.NotModified {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, http.StatusOK, gen.ParticipantList{Items: participantsItemsDTO(res.Items), Rev: res.Rev})
}

// CreateParticipants handles POST /projects/{id}/participants.
func (h *ParticipantsHandler) CreateParticipants(w http.ResponseWriter, r *http.Request, id gen.ProjectId) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	// The body is one of two shapes; decoding into optional fields tells them apart.
	var req struct {
		Count *int                    `json:"count"`
		Items *[]gen.ParticipantInput `json:"items"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		participantsFail(w, r, err)
		return
	}
	in := service.AddInput{ProjectID: id.String()}
	if req.Count != nil {
		in.Count = *req.Count
		if in.Count == 0 {
			participantsFail(w, r, domain.NewValidation(domain.FieldError{Field: "count", Reason: "must be 1-5000"}))
			return
		}
	}
	if req.Items != nil {
		in.HasItems = true
		for _, it := range *req.Items {
			var item service.ParticipantInput
			if it.Name != nil {
				item.Name = *it.Name
			}
			if it.Phone != nil {
				item.Phone = *it.Phone
			}
			in.Items = append(in.Items, item)
		}
	}
	rows, err := h.svc.Add(r.Context(), a, in)
	if err != nil {
		participantsFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, gen.ParticipantItems{Items: participantsItemsDTO(rows)})
}

// UpdateParticipant handles PATCH /participants/{id}.
func (h *ParticipantsHandler) UpdateParticipant(w http.ResponseWriter, r *http.Request, id gen.ParticipantId) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	var req gen.UpdateParticipantRequest
	if err := decodeJSON(w, r, &req); err != nil {
		participantsFail(w, r, err)
		return
	}
	saved, err := h.svc.Update(r.Context(), a, service.UpdateInput{
		ID: id.String(), Name: req.Name, Phone: req.Phone, Version: req.Version,
	})
	if err != nil {
		participantsFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, gen.ParticipantResponse{Item: participantsToDTO(saved)})
}

// LogPrinted handles POST /projects/{id}/participants/printed.
func (h *ParticipantsHandler) LogPrinted(w http.ResponseWriter, r *http.Request, id gen.ProjectId) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	var req gen.ParticipantIds
	if err := decodeJSON(w, r, &req); err != nil {
		participantsFail(w, r, err)
		return
	}
	if err := h.svc.LogPrinted(r.Context(), a, id.String(), participantsIDs(req.Ids)); err != nil {
		participantsFail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// DeleteParticipants handles POST /projects/{id}/participants/delete.
func (h *ParticipantsHandler) DeleteParticipants(w http.ResponseWriter, r *http.Request, id gen.ProjectId) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	var req gen.ParticipantIds
	if err := decodeJSON(w, r, &req); err != nil {
		participantsFail(w, r, err)
		return
	}
	n, err := h.svc.Delete(r.Context(), a, id.String(), participantsIDs(req.Ids))
	if err != nil {
		participantsFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, gen.DeletedCount{Deleted: n})
}

// ClearParticipants handles POST /projects/{id}/participants/clear.
func (h *ParticipantsHandler) ClearParticipants(w http.ResponseWriter, r *http.Request, id gen.ProjectId) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	var req gen.ClearParticipantsRequest
	if err := decodeJSON(w, r, &req); err != nil {
		participantsFail(w, r, err)
		return
	}
	n, err := h.svc.Clear(r.Context(), a, id.String(), req.ConfirmTitle)
	if err != nil {
		participantsFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, gen.DeletedCount{Deleted: n})
}
