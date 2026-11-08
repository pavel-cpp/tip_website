package http

import (
	"context"
	"net/http"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

// auditAPI is the part of *service.Audit the handler uses.
type auditAPI interface {
	List(ctx context.Context, a domain.Actor, q service.AuditQuery) (service.AuditPage, error)
}

// AuditHandler implements GET /admin/audit.
type AuditHandler struct{ svc auditAPI }

// NewAuditHandler returns the handler over the audit service.
func NewAuditHandler(svc auditAPI) *AuditHandler { return &AuditHandler{svc: svc} }

func auditOptionalUUID(s string) *openapi_types.UUID {
	if s == "" {
		return nil
	}
	id := participantsParseUUID(s)
	return &id
}

func auditToDTO(e domain.AuditEntry) gen.AuditEntry {
	meta := e.Meta
	if meta == nil {
		meta = map[string]any{}
	}
	var ip *string
	if e.IP != "" {
		ip = &e.IP
	}
	return gen.AuditEntry{
		Id: e.ID, At: e.At.UTC().Truncate(time.Microsecond), ActorId: auditOptionalUUID(e.ActorID),
		ActorLogin: e.ActorLogin, Action: e.Action, ProjectId: auditOptionalUUID(e.ProjectID),
		EntityId: auditOptionalUUID(e.EntityID), Meta: meta, Ip: ip,
	}
}

// ListAudit handles GET /admin/audit.
func (h *AuditHandler) ListAudit(w http.ResponseWriter, r *http.Request, params gen.ListAuditParams) {
	a, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	var q service.AuditQuery
	if params.Limit != nil {
		q.Limit = *params.Limit
		if q.Limit == 0 {
			q.Limit = -1 // an explicit 0 is invalid, not "default"
		}
	}
	if params.Before != nil {
		q.Before = *params.Before
	}
	if params.ProjectId != nil {
		q.ProjectID = params.ProjectId.String()
	}
	if params.Actor != nil {
		q.ActorID = params.Actor.String()
	}
	if params.Action != nil {
		q.Action = *params.Action
	}
	page, err := h.svc.List(r.Context(), a, q)
	if err != nil {
		fail(w, r, err)
		return
	}
	out := gen.AuditPage{Items: make([]gen.AuditEntry, len(page.Items))}
	for i, e := range page.Items {
		out.Items[i] = auditToDTO(e)
	}
	if page.Next != 0 {
		next := page.Next
		out.Next = &next
	}
	writeJSON(w, http.StatusOK, out)
}
