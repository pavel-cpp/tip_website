package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// AuditRepo stores the audit log. Entries hold ids and counts only.
type AuditRepo struct{ db *sql.DB }

// NewAuditRepo returns a repository over the pool.
func NewAuditRepo(db *sql.DB) *AuditRepo { return &AuditRepo{db: db} }

// Insert appends an entry. The actor's login snapshot is resolved in SQL so that the service
// needs no user lookup; an unknown actor is stored without a reference. The id and at fields
// of e are ignored: the database assigns them (at defaults to now()).
func (r *AuditRepo) Insert(ctx context.Context, e domain.AuditEntry) error {
	meta := e.Meta
	if meta == nil {
		meta = map[string]any{}
	}
	raw, err := json.Marshal(meta)
	if err != nil {
		return fmt.Errorf("encode audit meta: %w", err)
	}
	const q = `INSERT INTO audit_log (actor_id, actor_login, action, project_id, entity_id, meta, ip)
		VALUES (
			(SELECT id FROM users WHERE id = nullif($1, '')::uuid),
			coalesce((SELECT login FROM users WHERE id = nullif($1, '')::uuid), ''),
			$2,
			nullif($3, '')::uuid, nullif($4, '')::uuid, $5::jsonb, nullif($6, '')::inet)`
	if _, err := Querier(ctx, r.db).ExecContext(ctx, q, e.ActorID, e.Action, e.ProjectID, e.EntityID, string(raw), e.IP); err != nil {
		return fmt.Errorf("insert audit entry: %w", err)
	}
	return nil
}

// List returns entries newest first (id descending). f.Limit rows are returned at most; the
// caller asks for one more than it shows to learn whether another page exists.
func (r *AuditRepo) List(ctx context.Context, f domain.AuditFilter) ([]domain.AuditEntry, error) {
	var where []string
	var args []any
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, strings.ReplaceAll(cond, "?", "$"+strconv.Itoa(len(args))))
	}
	if f.Before > 0 {
		add("id < ?", f.Before)
	}
	if f.ProjectID != "" {
		add("project_id = ?::uuid", f.ProjectID)
	}
	if f.ActorID != "" {
		add("actor_id = ?::uuid", f.ActorID)
	}
	query := `SELECT id, at, coalesce(actor_id::text, ''), actor_login, action,
			coalesce(project_id::text, ''), coalesce(entity_id::text, ''), meta, coalesce(host(ip), '')
		FROM audit_log`
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	args = append(args, f.Limit)
	query += " ORDER BY id DESC LIMIT $" + strconv.Itoa(len(args))

	rows, err := Querier(ctx, r.db).QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list audit: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []domain.AuditEntry
	for rows.Next() {
		var (
			e   domain.AuditEntry
			raw []byte
		)
		if err := rows.Scan(&e.ID, &e.At, &e.ActorID, &e.ActorLogin, &e.Action, &e.ProjectID, &e.EntityID, &raw, &e.IP); err != nil {
			return nil, fmt.Errorf("scan audit entry: %w", err)
		}
		if err := json.Unmarshal(raw, &e.Meta); err != nil {
			return nil, fmt.Errorf("decode audit meta: %w", err)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list audit: %w", err)
	}
	return out, nil
}

// DeleteOlderThan deletes at most batch entries written before cutoff, oldest first, and
// returns how many were removed. Callers repeat until the count drops below batch, so the
// table is never locked for long.
func (r *AuditRepo) DeleteOlderThan(ctx context.Context, cutoff time.Time, batch int) (int, error) {
	const q = `DELETE FROM audit_log WHERE id IN (
		SELECT id FROM audit_log WHERE at < $1 ORDER BY id LIMIT $2)`
	res, err := Querier(ctx, r.db).ExecContext(ctx, q, cutoff, batch)
	if err != nil {
		return 0, fmt.Errorf("delete old audit entries: %w", err)
	}
	n, err := res.RowsAffected()
	return int(n), err
}

// DeleteBeyondMax keeps the newest keep entries and deletes at most batch of the older ones,
// oldest first. It returns how many were removed; callers repeat until it is below batch.
func (r *AuditRepo) DeleteBeyondMax(ctx context.Context, keep, batch int) (int, error) {
	const q = `DELETE FROM audit_log WHERE id IN (
		SELECT id FROM audit_log
		WHERE id <= (SELECT id FROM audit_log ORDER BY id DESC OFFSET $1 LIMIT 1)
		ORDER BY id LIMIT $2)`
	res, err := Querier(ctx, r.db).ExecContext(ctx, q, keep, batch)
	if err != nil {
		return 0, fmt.Errorf("delete excess audit entries: %w", err)
	}
	n, err := res.RowsAffected()
	return int(n), err
}
