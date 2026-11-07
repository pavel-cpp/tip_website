package domain

import (
	"strings"
	"unicode/utf8"
)

// Names of the system roles.
const (
	RoleAdmin  = "admin"
	RoleWorker = "worker"
)

// Role length limits; they mirror the CHECK constraints in the schema.
const (
	MinRoleNameLen        = 2
	MaxRoleNameLen        = 50
	MaxRoleDescriptionLen = 300
)

// Role is a named set of permissions assigned to users.
type Role struct {
	ID          string
	Name        string
	Description string
	// IsSystem marks roles created by the migrations (admin, worker): they can
	// never be deleted, and admin cannot be edited at all.
	IsSystem    bool
	Permissions []Permission
	// UserCount is filled by listing queries only.
	UserCount int
}

// RoleInput is validated input for creating or editing a role.
type RoleInput struct {
	Name        string
	Description string
	Permissions []Permission
}

// NormalizeRoleInput trims and validates role fields and normalizes the
// permission list (dependencies added, unknown codes rejected). All problems
// are reported together.
func NormalizeRoleInput(name, description string, perms []string) (RoleInput, error) {
	name = strings.TrimSpace(name)
	description = strings.TrimSpace(description)

	var errs []error
	if n := utf8.RuneCountInString(name); n < MinRoleNameLen || n > MaxRoleNameLen {
		errs = append(errs, fieldError("name", "must be 2-50 characters"))
	}
	if utf8.RuneCountInString(description) > MaxRoleDescriptionLen {
		errs = append(errs, fieldError("description", "must be at most 300 characters"))
	}
	normalized, permErr := NormalizePermissions(perms)
	errs = append(errs, permErr)
	if err := collect(errs...); err != nil {
		return RoleInput{}, err
	}
	return RoleInput{Name: name, Description: description, Permissions: normalized}, nil
}

// IsAdminRole reports whether r is the immutable system admin role.
func (r Role) IsAdminRole() bool { return r.IsSystem && r.Name == RoleAdmin }

// CheckDeletable returns ErrRoleSystem for system roles. Whether the role is
// still assigned (ROLE_IN_USE) is decided by the service from the database.
func (r Role) CheckDeletable() error {
	if r.IsSystem {
		return ErrRoleSystem
	}
	return nil
}

// Edited applies in to r and returns the result. The admin role cannot be
// edited (ErrRoleSystem); other system roles keep their name because the
// application looks them up by it, but may change description and permissions.
func (r Role) Edited(in RoleInput) (Role, error) {
	if r.IsAdminRole() {
		return Role{}, ErrRoleSystem
	}
	if r.IsSystem && in.Name != r.Name {
		return Role{}, fieldError("name", "the name of a system role cannot be changed")
	}
	r.Name = in.Name
	r.Description = in.Description
	r.Permissions = in.Permissions
	return r, nil
}
