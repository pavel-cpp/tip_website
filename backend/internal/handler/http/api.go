package http

import (
	"net/http"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

// APIDeps are the services behind the generated routes.
type APIDeps struct {
	Auth         AuthService
	Users        UsersService
	Roles        RolesService
	Projects     ProjectsService
	Participants *service.Participants
	Audit        *service.Audit
	System       *service.SystemService
	// MaxImageBytes bounds an uploaded project image (MAX_IMAGE_MB).
	MaxImageBytes int64
	// Now is the clock of the client error limiter; nil means time.Now.
	Now func() time.Time
}

// unimplementedAPI sits one embedding level below the area handlers, so any method an area
// defines wins over gen.Unimplemented in the composite.
type unimplementedAPI struct{ gen.Unimplemented }

// probeAPI serves the probe operations of the contract (GET /api/v1/healthz and /readyz);
// the same handlers also answer on the root paths used by the container healthcheck.
type probeAPI struct{ live, ready http.HandlerFunc }

func (p probeAPI) GetHealthz(w http.ResponseWriter, r *http.Request) { p.live(w, r) }
func (p probeAPI) GetReadyz(w http.ResponseWriter, r *http.Request)  { p.ready(w, r) }

// apiHandlers is the single gen.ServerInterface implementation: every area handler is
// embedded at the same depth ahead of the deeper gen.Unimplemented.
type apiHandlers struct {
	*AuthAPI
	*ProjectsHandler
	*ParticipantsHandler
	*AuditHandler
	*SystemHandler
	*ClientErrorsHandler
	probeAPI
	unimplementedAPI
}

var _ gen.ServerInterface = apiHandlers{}

func newAPIHandlers(d APIDeps, probes probeAPI) gen.ServerInterface {
	now := d.Now
	if now == nil {
		now = time.Now
	}
	return apiHandlers{
		AuthAPI:             NewAuthAPI(AuthAPIDeps{Auth: d.Auth, Users: d.Users, Roles: d.Roles}),
		ProjectsHandler:     NewProjectsHandler(d.Projects, d.MaxImageBytes),
		ParticipantsHandler: NewParticipantsHandler(d.Participants),
		AuditHandler:        NewAuditHandler(d.Audit),
		SystemHandler:       NewSystemHandler(d.System),
		ClientErrorsHandler: NewClientErrorsHandler(now),
		probeAPI:            probes,
	}
}
