package main

// Metric decorators for the business counters. They wrap the concrete services, so the service
// layer stays free of platform imports and of counting code.

import (
	"context"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/metrics"
	"github.com/pavel-cpp/tip_website/backend/internal/repository/memory"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

// wsMetrics adds the shared throttling counter to the ws gauges of PromMetrics:
// throttled frames go to tip_rate_limited_total{kind="ws"}.
type wsMetrics struct {
	*memory.PromMetrics
	m *metrics.Metrics
}

func (w wsMetrics) RateLimited() { w.m.RateLimited.WithLabelValues("ws").Inc() }

// meteredParticipants counts written rows and printed tickets (tip_participants_written_total,
// tip_tickets_printed_total). Only successful operations count.
type meteredParticipants struct {
	*service.Participants
	m *metrics.Metrics
}

func (p meteredParticipants) Add(ctx context.Context, a domain.Actor, in service.AddInput) ([]domain.Participant, error) {
	rows, err := p.Participants.Add(ctx, a, in)
	if err == nil {
		p.m.ParticipantsWritten.Add(float64(len(rows)))
	}
	return rows, err
}

func (p meteredParticipants) Update(ctx context.Context, a domain.Actor, in service.UpdateInput) (domain.Participant, error) {
	row, err := p.Participants.Update(ctx, a, in)
	if err == nil {
		p.m.ParticipantsWritten.Inc()
	}
	return row, err
}

func (p meteredParticipants) Import(ctx context.Context, a domain.Actor, in service.ImportInput) (service.ImportResult, error) {
	res, err := p.Participants.Import(ctx, a, in)
	if err == nil {
		p.m.ParticipantsWritten.Add(float64(res.Imported))
	}
	return res, err
}

func (p meteredParticipants) LogPrinted(ctx context.Context, a domain.Actor, projectID string, ids []string) error {
	err := p.Participants.LogPrinted(ctx, a, projectID, ids)
	if err == nil {
		p.m.TicketsPrinted.Add(float64(len(ids)))
	}
	return err
}

// meteredProjects counts project image uploads (tip_uploads_total{kind="project_image"}).
type meteredProjects struct {
	*service.ProjectService
	m *metrics.Metrics
}

func (p meteredProjects) PutImage(ctx context.Context, a domain.Actor, id, filename string, data []byte) (service.ProjectView, error) {
	v, err := p.ProjectService.PutImage(ctx, a, id, filename, data)
	p.m.Uploads.WithLabelValues("project_image", uploadResult(err)).Inc()
	return v, err
}

// meteredUsers counts avatar uploads (tip_uploads_total{kind="avatar"}).
type meteredUsers struct {
	*service.Users
	m *metrics.Metrics
}

func (u meteredUsers) SetAvatar(ctx context.Context, actor domain.Actor, raw []byte) (service.Profile, error) {
	p, err := u.Users.SetAvatar(ctx, actor, raw)
	u.m.Uploads.WithLabelValues("avatar", uploadResult(err)).Inc()
	return p, err
}

// uploadResult maps an upload error onto ok, rejected (the client's fault: validation, size,
// format, permissions) or error (internal failure or a full disk).
func uploadResult(err error) string {
	switch domain.CodeOf(err) {
	case "":
		return "ok"
	case domain.CodeInternal, domain.CodeDiskLow:
		return "error"
	default:
		return "rejected"
	}
}
