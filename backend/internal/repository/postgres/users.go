package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// PostgreSQL error codes handled by the repositories.
const (
	pgUniqueViolation     = "23505"
	pgForeignKeyViolation = "23503"
	pgInvalidText         = "22P02" // malformed uuid in a lookup: treated as "not found"
	pgRestrictViolation   = "23001" // ON DELETE RESTRICT
)

// adminLockKey serializes operations that may remove the last administrator.
const adminLockKey int64 = 0x7469705f61646d6e // "tip_admn"

func pgCode(err error) string {
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		return pe.Code
	}
	return ""
}

// UserRepo stores users, their role assignments and avatars.
type UserRepo struct{ db *sql.DB }

// NewUserRepo returns a repository over the pool; statements join the Tx carried by ctx.
func NewUserRepo(db *sql.DB) *UserRepo { return &UserRepo{db: db} }

const userSelect = `
SELECT u.id, u.login, u.display_name, u.color, u.locale, u.theme, u.password_hash,
       u.password_temporary, u.is_active, u.last_login_at, u.created_at, u.updated_at,
       COALESCE(a.sha256, '')
FROM users u LEFT JOIN user_avatars a ON a.user_id = u.id`

func scanUser(row interface{ Scan(...any) error }) (domain.UserRecord, error) {
	var r domain.UserRecord
	var locale, theme string
	err := row.Scan(&r.ID, &r.Login, &r.DisplayName, &r.Color, &locale, &theme, &r.PasswordHash,
		&r.PasswordTemporary, &r.IsActive, &r.LastLoginAt, &r.CreatedAt, &r.UpdatedAt, &r.AvatarSHA)
	r.Locale, r.Theme = domain.Locale(locale), domain.Theme(theme)
	return r, err
}

// attachRoles fills Roles and Permissions of recs with two queries regardless of their number.
func (r *UserRepo) attachRoles(ctx context.Context, recs []domain.UserRecord) error {
	if len(recs) == 0 {
		return nil
	}
	ids := make([]string, len(recs))
	index := make(map[string]int, len(recs))
	for i, rec := range recs {
		ids[i] = rec.ID
		index[rec.ID] = i
	}
	q := Querier(ctx, r.db)

	rows, err := q.QueryContext(ctx, `
SELECT ur.user_id, ro.id, ro.name FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
WHERE ur.user_id = ANY($1::uuid[]) ORDER BY ro.name`, ids)
	if err != nil {
		return fmt.Errorf("query user roles: %w", err)
	}
	for rows.Next() {
		var uid string
		var ref domain.RoleRef
		if err := rows.Scan(&uid, &ref.ID, &ref.Name); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan user role: %w", err)
		}
		recs[index[uid]].Roles = append(recs[index[uid]].Roles, ref)
	}
	if err := closeRows(rows); err != nil {
		return err
	}

	rows, err = q.QueryContext(ctx, `
SELECT DISTINCT ur.user_id, rp.permission FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
WHERE ur.user_id = ANY($1::uuid[])`, ids)
	if err != nil {
		return fmt.Errorf("query user permissions: %w", err)
	}
	sets := make(map[string]domain.PermissionSet, len(recs))
	for rows.Next() {
		var uid, perm string
		if err := rows.Scan(&uid, &perm); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan user permission: %w", err)
		}
		if sets[uid] == nil {
			sets[uid] = domain.PermissionSet{}
		}
		sets[uid][domain.Permission(perm)] = struct{}{}
	}
	if err := closeRows(rows); err != nil {
		return err
	}
	for uid, set := range sets {
		recs[index[uid]].Permissions = set.Sorted()
	}
	return nil
}

func closeRows(rows *sql.Rows) error {
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("iterate rows: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close rows: %w", err)
	}
	return nil
}

func (r *UserRepo) getOne(ctx context.Context, where string, arg any) (domain.UserRecord, error) {
	rec, err := scanUser(Querier(ctx, r.db).QueryRowContext(ctx, userSelect+" WHERE "+where, arg))
	if errors.Is(err, sql.ErrNoRows) || pgCode(err) == pgInvalidText {
		return domain.UserRecord{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.UserRecord{}, fmt.Errorf("query user: %w", err)
	}
	recs := []domain.UserRecord{rec}
	if err := r.attachRoles(ctx, recs); err != nil {
		return domain.UserRecord{}, err
	}
	return recs[0], nil
}

// GetByID returns a user or domain.ErrNotFound.
func (r *UserRepo) GetByID(ctx context.Context, id string) (domain.UserRecord, error) {
	return r.getOne(ctx, "u.id = $1", id)
}

// GetByLogin returns a user by its lower-case login or domain.ErrNotFound.
func (r *UserRepo) GetByLogin(ctx context.Context, login string) (domain.UserRecord, error) {
	return r.getOne(ctx, "u.login = $1", login)
}

// List returns all users ordered by login.
func (r *UserRepo) List(ctx context.Context) ([]domain.UserRecord, error) {
	rows, err := Querier(ctx, r.db).QueryContext(ctx, userSelect+" ORDER BY u.login")
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	var recs []domain.UserRecord
	for rows.Next() {
		rec, err := scanUser(rows)
		if err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("scan user: %w", err)
		}
		recs = append(recs, rec)
	}
	if err := closeRows(rows); err != nil {
		return nil, err
	}
	if err := r.attachRoles(ctx, recs); err != nil {
		return nil, err
	}
	return recs, nil
}

// Create inserts a user; a taken login yields a validation error on "login".
func (r *UserRepo) Create(ctx context.Context, u domain.NewUser) error {
	_, err := Querier(ctx, r.db).ExecContext(ctx, `
INSERT INTO users (id, login, display_name, color, password_hash, password_temporary, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
		u.ID, u.Login, u.DisplayName, u.Color, u.PasswordHash, u.PasswordTemporary, u.CreatedAt)
	if pgCode(err) == pgUniqueViolation {
		return domain.NewValidation(domain.FieldError{Field: "login", Reason: "is already taken"})
	}
	if err != nil {
		return fmt.Errorf("insert user: %w", err)
	}
	return nil
}

func (r *UserRepo) exec1(ctx context.Context, what, query string, args ...any) error {
	res, err := Querier(ctx, r.db).ExecContext(ctx, query, args...)
	if pgCode(err) == pgInvalidText {
		return domain.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("%s: %w", what, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return domain.ErrNotFound
	}
	return nil
}

// UpdateProfile changes the non-nil profile fields.
func (r *UserRepo) UpdateProfile(ctx context.Context, id string, p domain.ProfilePatch) error {
	var locale, theme *string
	if p.Locale != nil {
		s := string(*p.Locale)
		locale = &s
	}
	if p.Theme != nil {
		s := string(*p.Theme)
		theme = &s
	}
	return r.exec1(ctx, "update profile", `
UPDATE users SET display_name = COALESCE($2, display_name), color = COALESCE($3, color),
                 locale = COALESCE($4, locale), theme = COALESCE($5, theme), updated_at = now()
WHERE id = $1`, id, p.DisplayName, p.Color, locale, theme)
}

// SetPassword stores a new hash and the password_temporary flag.
func (r *UserRepo) SetPassword(ctx context.Context, id, hash string, temporary bool) error {
	return r.exec1(ctx, "set password", `
UPDATE users SET password_hash = $2, password_temporary = $3, updated_at = now() WHERE id = $1`, id, hash, temporary)
}

// SetActive activates or deactivates an account.
func (r *UserRepo) SetActive(ctx context.Context, id string, active bool) error {
	return r.exec1(ctx, "set active", `UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1`, id, active)
}

// TouchLastLogin records the time of the latest successful login.
func (r *UserRepo) TouchLastLogin(ctx context.Context, id string, at time.Time) error {
	return r.exec1(ctx, "touch last login", `UPDATE users SET last_login_at = $2 WHERE id = $1`, id, at)
}

// SetRoles replaces the roles of a user.
func (r *UserRepo) SetRoles(ctx context.Context, userID string, roleIDs []string) error {
	q := Querier(ctx, r.db)
	if _, err := q.ExecContext(ctx, `DELETE FROM user_roles WHERE user_id = $1`, userID); err != nil {
		return fmt.Errorf("clear user roles: %w", err)
	}
	if len(roleIDs) == 0 {
		return nil
	}
	if _, err := q.ExecContext(ctx,
		`INSERT INTO user_roles (user_id, role_id) SELECT $1, unnest($2::uuid[])`, userID, roleIDs); err != nil {
		return fmt.Errorf("assign user roles: %w", err)
	}
	return nil
}

// CountActiveAdmins counts active users holding the admin role. It first takes a
// transaction-scoped advisory lock so concurrent "remove an admin" operations queue up and
// each sees the effect of the previous one.
func (r *UserRepo) CountActiveAdmins(ctx context.Context) (int, error) {
	q := Querier(ctx, r.db)
	if _, err := q.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, adminLockKey); err != nil {
		return 0, fmt.Errorf("lock admins: %w", err)
	}
	var n int
	err := q.QueryRowContext(ctx, `
SELECT count(DISTINCT u.id) FROM users u
JOIN user_roles ur ON ur.user_id = u.id JOIN roles ro ON ro.id = ur.role_id
WHERE u.is_active AND ro.name = $1`, domain.RoleAdmin).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count admins: %w", err)
	}
	return n, nil
}

// PutAvatar inserts or replaces the avatar of a user.
func (r *UserRepo) PutAvatar(ctx context.Context, userID string, a domain.Avatar, at time.Time) error {
	_, err := Querier(ctx, r.db).ExecContext(ctx, `
INSERT INTO user_avatars (user_id, mime, data, sha256, updated_at) VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (user_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data,
                                    sha256 = EXCLUDED.sha256, updated_at = EXCLUDED.updated_at`,
		userID, a.MIME, a.Data, a.SHA256, at)
	if pgCode(err) == pgForeignKeyViolation {
		return domain.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("store avatar: %w", err)
	}
	return nil
}

// GetAvatar returns the avatar or domain.ErrNotFound.
func (r *UserRepo) GetAvatar(ctx context.Context, userID string) (domain.Avatar, error) {
	var a domain.Avatar
	err := Querier(ctx, r.db).QueryRowContext(ctx,
		`SELECT mime, data, sha256 FROM user_avatars WHERE user_id = $1`, userID).Scan(&a.MIME, &a.Data, &a.SHA256)
	if errors.Is(err, sql.ErrNoRows) || pgCode(err) == pgInvalidText {
		return domain.Avatar{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Avatar{}, fmt.Errorf("query avatar: %w", err)
	}
	return a, nil
}

// DeleteAvatar removes the avatar; a missing one is not an error.
func (r *UserRepo) DeleteAvatar(ctx context.Context, userID string) error {
	if _, err := Querier(ctx, r.db).ExecContext(ctx, `DELETE FROM user_avatars WHERE user_id = $1`, userID); err != nil {
		return fmt.Errorf("delete avatar: %w", err)
	}
	return nil
}
