package service

import (
	"context"
	"fmt"
	"slices"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// RolesDeps are the collaborators of Roles.
type RolesDeps struct {
	Roles RoleStore
	Authz AuthzState
	Epoch *Epoch
	Tx    Tx
	Audit Audit
	IDs   IDGen
}

// Roles implements role administration and the permission catalog.
type Roles struct {
	RolesDeps
}

// NewRoles builds the roles service.
func NewRoles(d RolesDeps) *Roles { return &Roles{RolesDeps: d} }

func (s *Roles) audit(ctx context.Context, e domain.AuditEntry) error {
	if s.Audit == nil {
		return nil
	}
	if err := s.Audit.Record(ctx, e); err != nil {
		return fmt.Errorf("record audit %s: %w", e.Action, err)
	}
	return nil
}

// Catalog returns the permission catalog (role.manage).
func (s *Roles) Catalog(actor domain.Actor) ([]domain.PermissionInfo, error) {
	if err := actor.Require(domain.PermRoleManage); err != nil {
		return nil, err
	}
	return domain.Catalog(), nil
}

// List returns all roles with permission lists and user counts (role.manage).
func (s *Roles) List(ctx context.Context, actor domain.Actor) ([]domain.Role, error) {
	if err := actor.Require(domain.PermRoleManage); err != nil {
		return nil, err
	}
	roles, err := s.Roles.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list roles: %w", err)
	}
	return roles, nil
}

// RoleDetail is a role together with the users that hold it.
type RoleDetail struct {
	Role  domain.Role
	Users []domain.UserRef
}

// Get returns one role and its users (role.manage).
func (s *Roles) Get(ctx context.Context, actor domain.Actor, id string) (RoleDetail, error) {
	if err := actor.Require(domain.PermRoleManage); err != nil {
		return RoleDetail{}, err
	}
	role, err := s.Roles.Get(ctx, id)
	if err != nil {
		return RoleDetail{}, fmt.Errorf("load role: %w", err)
	}
	users, err := s.Roles.Users(ctx, id)
	if err != nil {
		return RoleDetail{}, fmt.Errorf("load role users: %w", err)
	}
	role.UserCount = len(users)
	return RoleDetail{Role: role, Users: users}, nil
}

// checkRoleName rejects names reserved for internal markers.
func checkRoleName(in domain.RoleInput) error {
	if in.Name == RolePasswordChange {
		return domain.NewValidation(domain.FieldError{Field: "name", Reason: "this name is reserved"})
	}
	return nil
}

// RoleCreate is the request to create a role.
type RoleCreate struct {
	Name        string
	Description string
	Permissions []string
}

// Create adds a role (role.manage). Missing dependent permissions are added automatically. A
// new role is assigned to nobody, so the permission epoch stays unchanged.
func (s *Roles) Create(ctx context.Context, actor domain.Actor, in RoleCreate) (domain.Role, error) {
	if err := actor.Require(domain.PermRoleManage); err != nil {
		return domain.Role{}, err
	}
	norm, err := domain.NormalizeRoleInput(in.Name, in.Description, in.Permissions)
	if err != nil {
		return domain.Role{}, err
	}
	if err := checkRoleName(norm); err != nil {
		return domain.Role{}, err
	}
	role := domain.Role{ID: s.IDs.NewID(), Name: norm.Name, Description: norm.Description, Permissions: norm.Permissions}
	err = s.Tx.Do(ctx, func(ctx context.Context) error {
		if err := s.Roles.Create(ctx, role); err != nil {
			return err
		}
		return s.audit(ctx, domain.AuditEntry{Action: "role.create", ActorID: actor.UserID, TargetID: role.ID,
			Meta: map[string]any{"permissions": permStrings(role.Permissions)}})
	})
	if err != nil {
		return domain.Role{}, err
	}
	return role, nil
}

// RoleUpdate lists the role fields to change (nil leaves a field as is).
type RoleUpdate struct {
	Name        *string
	Description *string
	Permissions *[]string
}

// Update edits a role (role.manage). The admin role cannot be edited. Renaming or changing
// permissions bumps the permission epoch in the same transaction.
func (s *Roles) Update(ctx context.Context, actor domain.Actor, id string, in RoleUpdate) (domain.Role, error) {
	if err := actor.Require(domain.PermRoleManage); err != nil {
		return domain.Role{}, err
	}
	var out domain.Role
	var epoch int64
	err := s.Tx.Do(ctx, func(ctx context.Context) error {
		cur, err := s.Roles.Get(ctx, id)
		if err != nil {
			return fmt.Errorf("load role: %w", err)
		}
		if cur.IsAdminRole() {
			return domain.ErrRoleSystem
		}
		name, desc, perms := cur.Name, cur.Description, permStrings(cur.Permissions)
		if in.Name != nil {
			name = *in.Name
		}
		if in.Description != nil {
			desc = *in.Description
		}
		if in.Permissions != nil {
			perms = *in.Permissions
		}
		norm, err := domain.NormalizeRoleInput(name, desc, perms)
		if err != nil {
			return err
		}
		if err := checkRoleName(norm); err != nil {
			return err
		}
		next, err := cur.Edited(norm)
		if err != nil {
			return err
		}
		if err := s.Roles.Update(ctx, next); err != nil {
			return err
		}
		added, removed := permDiff(cur.Permissions, next.Permissions)
		if len(added)+len(removed) > 0 || next.Name != cur.Name {
			if epoch, err = s.Authz.BumpEpoch(ctx); err != nil {
				return fmt.Errorf("bump permission epoch: %w", err)
			}
		}
		out = next
		return s.audit(ctx, domain.AuditEntry{Action: "role.update", ActorID: actor.UserID, TargetID: id,
			Meta: map[string]any{"addedPermissions": added, "removedPermissions": removed}})
	})
	if err != nil {
		return domain.Role{}, err
	}
	if epoch > 0 {
		s.Epoch.Set(epoch)
	}
	return out, nil
}

// Delete removes an unused, non-system role (role.manage).
func (s *Roles) Delete(ctx context.Context, actor domain.Actor, id string) error {
	if err := actor.Require(domain.PermRoleManage); err != nil {
		return err
	}
	return s.Tx.Do(ctx, func(ctx context.Context) error {
		role, err := s.Roles.Get(ctx, id)
		if err != nil {
			return fmt.Errorf("load role: %w", err)
		}
		if err := role.CheckDeletable(); err != nil {
			return err
		}
		users, err := s.Roles.Users(ctx, id)
		if err != nil {
			return fmt.Errorf("load role users: %w", err)
		}
		if len(users) > 0 {
			ids := make([]string, len(users))
			for i, u := range users {
				ids[i] = u.ID
			}
			return domain.NewRoleInUse(ids)
		}
		if err := s.Roles.Delete(ctx, id); err != nil {
			return err
		}
		return s.audit(ctx, domain.AuditEntry{Action: "role.delete", ActorID: actor.UserID, TargetID: id})
	})
}

// SyncPermissions mirrors the code catalog into the database at startup. The admin role always
// holds the whole catalog; worker gets its defaults only while it has no permissions at all.
// The permission epoch grows when anything changed.
func (s *Roles) SyncPermissions(ctx context.Context) error {
	var epoch int64
	err := s.Tx.Do(ctx, func(ctx context.Context) error {
		changed, err := s.Roles.UpsertCatalog(ctx, domain.Catalog())
		if err != nil {
			return fmt.Errorf("sync catalog: %w", err)
		}
		admin, err := s.Roles.GetByName(ctx, domain.RoleAdmin)
		if err != nil {
			return fmt.Errorf("find admin role: %w", err)
		}
		adminChanged, err := s.Roles.SetPermissions(ctx, admin.ID, domain.AllPermissions())
		if err != nil {
			return fmt.Errorf("sync admin permissions: %w", err)
		}
		changed = changed || adminChanged

		worker, err := s.Roles.GetByName(ctx, domain.RoleWorker)
		if err != nil {
			return fmt.Errorf("find worker role: %w", err)
		}
		if len(worker.Permissions) == 0 {
			defaults, err := domain.NormalizePermissions(permStrings(domain.DefaultWorkerPermissions()))
			if err != nil {
				return fmt.Errorf("normalize worker defaults: %w", err)
			}
			workerChanged, err := s.Roles.SetPermissions(ctx, worker.ID, defaults)
			if err != nil {
				return fmt.Errorf("sync worker permissions: %w", err)
			}
			changed = changed || workerChanged
		}
		if changed {
			if epoch, err = s.Authz.BumpEpoch(ctx); err != nil {
				return fmt.Errorf("bump permission epoch: %w", err)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if epoch > 0 {
		s.Epoch.Set(epoch)
	}
	return nil
}

func permStrings(in []domain.Permission) []string {
	out := make([]string, len(in))
	for i, p := range in {
		out[i] = string(p)
	}
	return out
}

// permDiff returns the permissions present in next but not in cur (added) and vice versa.
func permDiff(cur, next []domain.Permission) (added, removed []string) {
	added, removed = []string{}, []string{}
	for _, p := range next {
		if !slices.Contains(cur, p) {
			added = append(added, string(p))
		}
	}
	for _, p := range cur {
		if !slices.Contains(next, p) {
			removed = append(removed, string(p))
		}
	}
	return added, removed
}
