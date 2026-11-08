package main

// Small adapters that join the layers. The service ports are declared by the services, and
// the repositories and platform packages stay unaware of them, so every mismatch between two
// streams is resolved here instead of in the layers.

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/imaging"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/metrics"
	"github.com/pavel-cpp/tip_website/backend/internal/repository/memory"
	"github.com/pavel-cpp/tip_website/backend/internal/repository/postgres"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

// Compile-time proof that the concrete types satisfy the ports they are wired into.
var (
	_ service.ParticipantLocks    = (*memory.Hub)(nil)
	_ service.ParticipantNotifier = (*memory.Hub)(nil)
	_ service.ProjectEvents       = (*memory.Hub)(nil)
	_ service.CollabRooms         = (*memory.Hub)(nil)
	_ service.ProjectReader       = (*postgres.ProjectRepo)(nil)
	_ service.AuditRecorder       = (*service.Audit)(nil)
)

// projectAudit stores project actions in the single audit log.
type projectAudit struct{ audit *service.Audit }

func (a projectAudit) Record(ctx context.Context, e service.ProjectAuditEntry) error {
	return a.audit.Record(ctx, e.Actor, e.Action, e.ProjectID, "", e.Meta)
}

// accountAudit stores account actions (login, users, roles) in the single audit log.
type accountAudit struct{ audit *service.Audit }

func (a accountAudit) Record(ctx context.Context, e domain.AccountAuditEntry) error {
	if e.IP != "" {
		ctx = service.WithClientIP(ctx, e.IP)
	}
	return a.audit.Record(ctx, domain.Actor{UserID: e.ActorID}, e.Action, "", e.TargetID, e.Meta)
}

// avatarProcessor adapts the imaging package to the avatar port of the users service.
type avatarProcessor struct{ img *imaging.Processor }

func (p avatarProcessor) ProcessAvatar(_ context.Context, raw []byte) (string, []byte, error) {
	out, _, err := p.img.Avatar(raw)
	if err != nil {
		return "", nil, err
	}
	return imaging.MimeJPEG, out, nil
}

// projectAccess hides projects from actors who must not see them (docs/02-architecture.md,
// section 5.4: a hidden project is reported as not found).
type projectAccess struct{ projects *postgres.ProjectRepo }

func (a projectAccess) EnsureVisible(ctx context.Context, actor domain.Actor, projectID string) error {
	if !actor.Can(domain.PermProjectView) {
		return domain.ErrNotFound
	}
	p, err := a.projects.Get(ctx, projectID)
	if err != nil {
		return err
	}
	if p.IsFinished() && !actor.Can(domain.PermProjectViewFinished) {
		return domain.ErrNotFound
	}
	return nil
}

// peerDirectory builds presence cards from the users table.
type peerDirectory struct{ users *postgres.UserRepo }

func (d peerDirectory) Peer(ctx context.Context, userID string) (domain.Peer, error) {
	rec, err := d.users.GetByID(ctx, userID)
	if err != nil {
		return domain.Peer{}, err
	}
	p := domain.Peer{ID: rec.ID, DisplayName: rec.DisplayName, Color: rec.Color}
	if rec.AvatarSHA != "" {
		p.AvatarURL = "/api/v1/users/" + rec.ID + "/avatar?v=" + rec.AvatarSHA[:min(8, len(rec.AvatarSHA))]
	}
	return p, nil
}

// meteredTokens counts access token revocation lookups (tip_blacklist_checks_total). An error
// here means Redis is unavailable; whether that fails the request is decided by REDIS_FAIL_MODE.
type meteredTokens struct {
	service.TokenStore
	m *metrics.Metrics
}

func (t meteredTokens) Revocation(ctx context.Context, q domain.RevocationQuery) (domain.RevocationState, error) {
	st, err := t.TokenStore.Revocation(ctx, q)
	result := "ok"
	switch {
	case err != nil:
		result = "error"
	case st.AccessRevoked || st.FamilyClosed:
		result = "revoked"
	}
	t.m.BlacklistChecks.WithLabelValues(result).Inc()
	return st, err
}

// meteredAuth counts logins and refreshes (tip_logins_total, tip_token_refresh_total).
type meteredAuth struct {
	*service.Auth
	m *metrics.Metrics
}

func (a meteredAuth) Login(ctx context.Context, in service.LoginInput) (service.Session, error) {
	s, err := a.Auth.Login(ctx, in)
	a.m.Logins.WithLabelValues(outcome(err, map[domain.Code]string{
		domain.CodeBadCredentials: "bad_credentials",
		domain.CodeRateLimited:    "rate_limited",
	})).Inc()
	return s, err
}

func (a meteredAuth) Refresh(ctx context.Context, token string) (service.Session, error) {
	s, err := a.Auth.Refresh(ctx, token)
	a.m.TokenRefresh.WithLabelValues(outcome(err, map[domain.Code]string{
		domain.CodeRefreshInvalid: "invalid",
	})).Inc()
	return s, err
}

// outcome maps an error onto a metric label: "ok" for nil, the listed label for known codes
// and "error" for everything else.
func outcome(err error, known map[domain.Code]string) string {
	if err == nil {
		return "ok"
	}
	if label, ok := known[domain.CodeOf(err)]; ok {
		return label
	}
	return "error"
}

// httpPing returns a ping function that succeeds on any 2xx answer of url.
func httpPing(client *http.Client, url string) func(context.Context) error {
	return func(ctx context.Context) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode/100 != 2 {
			return errors.New(resp.Status)
		}
		return nil
	}
}

// pingEvery calls ping on a ticker until ctx ends and reports each result to set.
func pingEvery(ctx context.Context, every time.Duration, ping func(context.Context) error, set func(up bool)) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		pctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		set(ping(pctx) == nil)
		cancel()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
