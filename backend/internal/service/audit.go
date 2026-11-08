package service

import (
	"context"
	"fmt"
	"net/netip"
	"strings"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// Audit list paging bounds (docs/04-api.md, section 3).
const (
	DefaultAuditPageSize = 50
	MaxAuditPageSize     = 200
)

type clientIPKey struct{}

// WithClientIP stores the client address for audit entries written with ctx. The transport
// layer sets it from the trusted source (for example the proxy-provided address); an
// unparsable value is ignored when an entry is recorded.
func WithClientIP(ctx context.Context, ip string) context.Context {
	return context.WithValue(ctx, clientIPKey{}, ip)
}

func clientIPFrom(ctx context.Context) string {
	raw, _ := ctx.Value(clientIPKey{}).(string)
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if ap, err := netip.ParseAddrPort(raw); err == nil {
		return ap.Addr().Unmap().String()
	}
	if a, err := netip.ParseAddr(raw); err == nil {
		return a.Unmap().String()
	}
	return ""
}

// AuditConfig holds the retention limits; zero values select the documented defaults.
type AuditConfig struct {
	RetentionDays int
	MaxRows       int
}

// Audit records and serves the audit log and enforces its retention.
type Audit struct {
	store AuditStore
	clock Clock
	cfg   AuditConfig
}

// NewAudit builds the audit service.
func NewAudit(store AuditStore, clock Clock, cfg AuditConfig) *Audit {
	if cfg.RetentionDays <= 0 {
		cfg.RetentionDays = domain.DefaultAuditRetentionDays
	}
	if cfg.MaxRows <= 0 {
		cfg.MaxRows = domain.DefaultAuditMaxRows
	}
	return &Audit{store: store, clock: clock, cfg: cfg}
}

var _ AuditRecorder = (*Audit)(nil)

// Record appends an audit entry written on behalf of actor. It performs no permission check:
// it is called by services after they authorized the action. meta must contain ids and
// counts only.
func (s *Audit) Record(ctx context.Context, actor domain.Actor, action, projectID, entityID string, meta map[string]any) error {
	if action == "" {
		return fmt.Errorf("record audit entry: empty action")
	}
	err := s.store.Insert(ctx, domain.AuditEntry{
		ActorID:   actor.UserID,
		Action:    action,
		ProjectID: projectID,
		EntityID:  entityID,
		Meta:      meta,
		IP:        clientIPFrom(ctx),
	})
	if err != nil {
		return fmt.Errorf("record audit entry %q: %w", action, err)
	}
	return nil
}

// AuditQuery selects a page of the audit log.
type AuditQuery struct {
	// Limit is the page size; zero means DefaultAuditPageSize.
	Limit     int
	Before    int64
	ProjectID string
	ActorID   string
}

// AuditPage is one page of entries, newest first.
type AuditPage struct {
	Items []domain.AuditEntry
	// Next is the value for the next page's Before, or 0 on the last page.
	Next int64
}

// List returns a page of the audit log for administrators (audit.view).
func (s *Audit) List(ctx context.Context, actor domain.Actor, q AuditQuery) (AuditPage, error) {
	if err := actor.Require(domain.PermAuditView); err != nil {
		return AuditPage{}, err
	}
	if q.Limit == 0 {
		q.Limit = DefaultAuditPageSize
	}
	var bad []domain.FieldError
	if q.Limit < 1 || q.Limit > MaxAuditPageSize {
		bad = append(bad, domain.FieldError{Field: "limit", Reason: "must be 1-200"})
	}
	if q.Before < 0 {
		bad = append(bad, domain.FieldError{Field: "before", Reason: "must be positive"})
	}
	if len(bad) > 0 {
		return AuditPage{}, domain.NewValidation(bad...)
	}

	// One extra row tells whether another page exists without a second query.
	rows, err := s.store.List(ctx, domain.AuditFilter{
		ProjectID: q.ProjectID, ActorID: q.ActorID, Before: q.Before, Limit: q.Limit + 1,
	})
	if err != nil {
		return AuditPage{}, fmt.Errorf("list audit: %w", err)
	}
	page := AuditPage{Items: rows}
	if len(rows) > q.Limit {
		page.Items = rows[:q.Limit]
		page.Next = page.Items[q.Limit-1].ID
	}
	return page, nil
}

// RetentionResult reports how many entries a retention run removed.
type RetentionResult struct {
	ByAge   int
	ByCount int
}

// Retention deletes entries older than the retention window and entries beyond the row cap,
// oldest first in batches of domain.AuditPurgeBatch so the table is never locked for long.
// A scheduler calls it daily; it stops early when ctx is cancelled and returns what it
// removed so far together with the error.
func (s *Audit) Retention(ctx context.Context) (RetentionResult, error) {
	var res RetentionResult
	cutoff := s.clock.Now().Add(-time.Duration(s.cfg.RetentionDays) * 24 * time.Hour)
	for {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		n, err := s.store.DeleteOlderThan(ctx, cutoff, domain.AuditPurgeBatch)
		if err != nil {
			return res, fmt.Errorf("audit retention by age: %w", err)
		}
		res.ByAge += n
		if n < domain.AuditPurgeBatch {
			break
		}
	}
	for {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		n, err := s.store.DeleteBeyondMax(ctx, s.cfg.MaxRows, domain.AuditPurgeBatch)
		if err != nil {
			return res, fmt.Errorf("audit retention by count: %w", err)
		}
		res.ByCount += n
		if n < domain.AuditPurgeBatch {
			break
		}
	}
	return res, nil
}
