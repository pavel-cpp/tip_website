package postgres

import (
	"context"
	"database/sql"
	"fmt"
)

// AuthzRepo stores the permission epoch (authz_state).
type AuthzRepo struct{ db *sql.DB }

// NewAuthzRepo returns a repository over the pool.
func NewAuthzRepo(db *sql.DB) *AuthzRepo { return &AuthzRepo{db: db} }

// Epoch reads the current permission epoch.
func (r *AuthzRepo) Epoch(ctx context.Context) (int64, error) {
	var e int64
	if err := Querier(ctx, r.db).QueryRowContext(ctx, `SELECT epoch FROM authz_state WHERE id = 1`).Scan(&e); err != nil {
		return 0, fmt.Errorf("read permission epoch: %w", err)
	}
	return e, nil
}

// BumpEpoch increments the epoch. Called with the context of the transaction that changes
// roles, so the bump commits or rolls back together with the change.
func (r *AuthzRepo) BumpEpoch(ctx context.Context) (int64, error) {
	var e int64
	if err := Querier(ctx, r.db).QueryRowContext(ctx,
		`UPDATE authz_state SET epoch = epoch + 1 WHERE id = 1 RETURNING epoch`).Scan(&e); err != nil {
		return 0, fmt.Errorf("bump permission epoch: %w", err)
	}
	return e, nil
}
