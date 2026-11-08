package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"slices"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// RoleRepo stores roles, their permissions and the permission catalog mirror.
type RoleRepo struct{ db *sql.DB }

// NewRoleRepo returns a repository over the pool; statements join the Tx carried by ctx.
func NewRoleRepo(db *sql.DB) *RoleRepo { return &RoleRepo{db: db} }

const roleSelect = `
SELECT r.id, r.name, r.description, r.is_system,
       (SELECT count(*) FROM user_roles ur WHERE ur.role_id = r.id)
FROM roles r`

func (r *RoleRepo) query(ctx context.Context, where string, args ...any) ([]domain.Role, error) {
	q := Querier(ctx, r.db)
	rows, err := q.QueryContext(ctx, roleSelect+where+" ORDER BY r.name", args...)
	if err != nil {
		return nil, fmt.Errorf("query roles: %w", err)
	}
	var roles []domain.Role
	for rows.Next() {
		var ro domain.Role
		if err := rows.Scan(&ro.ID, &ro.Name, &ro.Description, &ro.IsSystem, &ro.UserCount); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("scan role: %w", err)
		}
		roles = append(roles, ro)
	}
	if err := closeRows(rows); err != nil {
		return nil, err
	}
	if len(roles) == 0 {
		return roles, nil
	}
	ids := make([]string, len(roles))
	index := make(map[string]int, len(roles))
	for i, ro := range roles {
		ids[i] = ro.ID
		index[ro.ID] = i
	}
	prows, err := q.QueryContext(ctx, `SELECT role_id, permission FROM role_permissions WHERE role_id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, fmt.Errorf("query role permissions: %w", err)
	}
	sets := make(map[string]domain.PermissionSet)
	for prows.Next() {
		var id, perm string
		if err := prows.Scan(&id, &perm); err != nil {
			_ = prows.Close()
			return nil, fmt.Errorf("scan role permission: %w", err)
		}
		if sets[id] == nil {
			sets[id] = domain.PermissionSet{}
		}
		sets[id][domain.Permission(perm)] = struct{}{}
	}
	if err := closeRows(prows); err != nil {
		return nil, err
	}
	for id, set := range sets {
		roles[index[id]].Permissions = set.Sorted()
	}
	return roles, nil
}

// List returns all roles with permissions and user counts.
func (r *RoleRepo) List(ctx context.Context) ([]domain.Role, error) { return r.query(ctx, "") }

func (r *RoleRepo) one(ctx context.Context, where string, arg any) (domain.Role, error) {
	roles, err := r.query(ctx, " WHERE "+where, arg)
	if pgCode(err) == pgInvalidText {
		return domain.Role{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Role{}, err
	}
	if len(roles) == 0 {
		return domain.Role{}, domain.ErrNotFound
	}
	return roles[0], nil
}

// Get returns a role or domain.ErrNotFound.
func (r *RoleRepo) Get(ctx context.Context, id string) (domain.Role, error) {
	return r.one(ctx, "r.id = $1", id)
}

// GetByName returns a role by exact name or domain.ErrNotFound.
func (r *RoleRepo) GetByName(ctx context.Context, name string) (domain.Role, error) {
	return r.one(ctx, "r.name = $1", name)
}

// GetMany returns the existing roles among ids.
func (r *RoleRepo) GetMany(ctx context.Context, ids []string) ([]domain.Role, error) {
	roles, err := r.query(ctx, " WHERE r.id = ANY($1::uuid[])", ids)
	if err != nil && pgCode(err) == pgInvalidText {
		return nil, nil
	}
	return roles, err
}

func (r *RoleRepo) setPerms(ctx context.Context, id string, perms []domain.Permission) error {
	q := Querier(ctx, r.db)
	if _, err := q.ExecContext(ctx, `DELETE FROM role_permissions WHERE role_id = $1`, id); err != nil {
		return fmt.Errorf("clear role permissions: %w", err)
	}
	if len(perms) == 0 {
		return nil
	}
	codes := make([]string, len(perms))
	for i, p := range perms {
		codes[i] = string(p)
	}
	if _, err := q.ExecContext(ctx,
		`INSERT INTO role_permissions (role_id, permission) SELECT $1, unnest($2::text[])`, id, codes); err != nil {
		return fmt.Errorf("insert role permissions: %w", err)
	}
	return nil
}

// Create inserts a role with its permissions; a taken name yields a validation error.
func (r *RoleRepo) Create(ctx context.Context, ro domain.Role) error {
	_, err := Querier(ctx, r.db).ExecContext(ctx,
		`INSERT INTO roles (id, name, description, is_system) VALUES ($1, $2, $3, false)`, ro.ID, ro.Name, ro.Description)
	if pgCode(err) == pgUniqueViolation {
		return domain.NewValidation(domain.FieldError{Field: "name", Reason: "is already taken"})
	}
	if err != nil {
		return fmt.Errorf("insert role: %w", err)
	}
	return r.setPerms(ctx, ro.ID, ro.Permissions)
}

// Update stores name, description and the complete permission list.
func (r *RoleRepo) Update(ctx context.Context, ro domain.Role) error {
	res, err := Querier(ctx, r.db).ExecContext(ctx,
		`UPDATE roles SET name = $2, description = $3, updated_at = now() WHERE id = $1`, ro.ID, ro.Name, ro.Description)
	if pgCode(err) == pgUniqueViolation {
		return domain.NewValidation(domain.FieldError{Field: "name", Reason: "is already taken"})
	}
	if err != nil {
		return fmt.Errorf("update role: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return domain.ErrNotFound
	}
	return r.setPerms(ctx, ro.ID, ro.Permissions)
}

// Delete removes a role; an assigned role yields domain.ErrRoleInUse.
func (r *RoleRepo) Delete(ctx context.Context, id string) error {
	res, err := Querier(ctx, r.db).ExecContext(ctx, `DELETE FROM roles WHERE id = $1`, id)
	if c := pgCode(err); c == pgForeignKeyViolation || c == pgRestrictViolation {
		return domain.ErrRoleInUse
	}
	if err != nil {
		return fmt.Errorf("delete role: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return domain.ErrNotFound
	}
	return nil
}

// Users returns the users holding the role, ordered by display name.
func (r *RoleRepo) Users(ctx context.Context, roleID string) ([]domain.UserRef, error) {
	rows, err := Querier(ctx, r.db).QueryContext(ctx, `
SELECT u.id, u.display_name, u.color, COALESCE(a.sha256, '')
FROM user_roles ur JOIN users u ON u.id = ur.user_id LEFT JOIN user_avatars a ON a.user_id = u.id
WHERE ur.role_id = $1 ORDER BY u.display_name, u.id`, roleID)
	if err != nil {
		return nil, fmt.Errorf("query role users: %w", err)
	}
	var out []domain.UserRef
	for rows.Next() {
		var u domain.UserRef
		if err := rows.Scan(&u.ID, &u.DisplayName, &u.Color, &u.AvatarSHA); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("scan role user: %w", err)
		}
		out = append(out, u)
	}
	if err := closeRows(rows); err != nil {
		return nil, err
	}
	return out, nil
}

// UpsertCatalog mirrors the code catalog into the permissions table and removes codes that
// left the catalog (role_permissions rows cascade). It reports whether anything changed.
func (r *RoleRepo) UpsertCatalog(ctx context.Context, catalog []domain.PermissionInfo) (bool, error) {
	q := Querier(ctx, r.db)
	changed := false
	codes := make([]string, len(catalog))
	for i, p := range catalog {
		codes[i] = string(p.Code)
		res, err := q.ExecContext(ctx, `
INSERT INTO permissions (code, grp, description) VALUES ($1, $2, $3)
ON CONFLICT (code) DO UPDATE SET grp = EXCLUDED.grp, description = EXCLUDED.description
WHERE (permissions.grp, permissions.description) IS DISTINCT FROM (EXCLUDED.grp, EXCLUDED.description)`,
			string(p.Code), p.Group, p.Description)
		if err != nil {
			return false, fmt.Errorf("upsert permission %s: %w", p.Code, err)
		}
		if n, _ := res.RowsAffected(); n > 0 {
			changed = true
		}
	}
	res, err := q.ExecContext(ctx, `DELETE FROM permissions WHERE code <> ALL($1::text[])`, codes)
	if err != nil {
		return false, fmt.Errorf("prune permissions: %w", err)
	}
	if n, _ := res.RowsAffected(); n > 0 {
		changed = true
	}
	return changed, nil
}

// SetPermissions replaces the permissions of a role and reports whether the set changed.
func (r *RoleRepo) SetPermissions(ctx context.Context, roleID string, perms []domain.Permission) (bool, error) {
	cur, err := r.Get(ctx, roleID)
	if err != nil {
		return false, err
	}
	want := domain.NewPermissionSet(perms...).Sorted()
	if slices.Equal(cur.Permissions, want) {
		return false, nil
	}
	if err := r.setPerms(ctx, roleID, want); err != nil {
		return false, err
	}
	return true, nil
}
