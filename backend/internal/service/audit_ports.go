package service

import (
	"context"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// AuditStore is the audit log storage used by Audit. Implemented by
// repository/postgres.AuditRepo; every method joins the transaction carried by ctx.
type AuditStore interface {
	// Insert appends an entry; the store resolves the actor's login snapshot.
	Insert(ctx context.Context, e domain.AuditEntry) error
	// List returns entries newest first, at most f.Limit of them.
	List(ctx context.Context, f domain.AuditFilter) ([]domain.AuditEntry, error)
	// DeleteOlderThan deletes at most batch entries written before cutoff and returns the count.
	DeleteOlderThan(ctx context.Context, cutoff time.Time, batch int) (int, error)
	// DeleteBeyondMax keeps the newest keep entries, deletes at most batch older ones and
	// returns the count.
	DeleteBeyondMax(ctx context.Context, keep, batch int) (int, error)
}

// AuditRecorder is what business services use to write audit entries. *Audit implements it.
// Record joins the transaction carried by ctx, so an entry commits or rolls back together
// with the change it describes. meta must hold ids and counts only, never personal data.
type AuditRecorder interface {
	Record(ctx context.Context, actor domain.Actor, action, projectID, entityID string, meta map[string]any) error
}
