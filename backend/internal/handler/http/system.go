package http

// Wiring (done by the lead): embed *SystemHandler (NewSystemHandler(systemService)) in the
// handler struct that implements gen.ServerInterface; it provides GetSystem
// (GET /api/v1/admin/system, system.view). The authentication middleware must already have
// stored the actor with WithActor.

import (
	"context"
	"net/http"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

// systemStatusProvider is satisfied by *service.SystemService.
type systemStatusProvider interface {
	Status(ctx context.Context, actor domain.Actor) (service.SystemStatus, error)
}

// SystemHandler serves the admin system status.
type SystemHandler struct {
	svc systemStatusProvider
}

// NewSystemHandler builds the handler around the system service.
func NewSystemHandler(svc systemStatusProvider) *SystemHandler { return &SystemHandler{svc: svc} }

// GetSystem handles GET /admin/system.
func (h *SystemHandler) GetSystem(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorOrFail(w, r)
	if !ok {
		return
	}
	st, err := h.svc.Status(r.Context(), actor)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, systemStatusToResponse(st))
}

func systemStatusToResponse(st service.SystemStatus) gen.SystemStatus {
	var out gen.SystemStatus
	out.Version = st.Version
	out.Uptime = int(st.Uptime.Seconds())
	out.Db.SizeBytes = st.DBSizeBytes
	out.Db.Pool.Open, out.Db.Pool.InUse = st.Pool.Open, st.Pool.InUse
	out.Db.Pool.Idle, out.Db.Pool.MaxOpen = st.Pool.Idle, st.Pool.MaxOpen
	out.Disk.Free, out.Disk.Total = st.DiskFree, st.DiskTotal
	out.Retention.ObsDays, out.Retention.AuditDays = st.ObsDays, st.AuditDays
	out.Uploads.SizeBytes = st.UploadsBytes
	out.Checks = make([]gen.SystemCheck, len(st.Checks))
	for i, c := range st.Checks {
		out.Checks[i] = gen.SystemCheck{Name: c.Name, Status: gen.SystemCheckStatus(c.Status), Detail: c.Detail}
	}
	return out
}
