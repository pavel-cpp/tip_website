package domain

import (
	"fmt"
	"slices"
)

// Permission is a code from the permission catalog. The catalog is defined by
// code, mirrored into the permissions table at start, and packed into access
// tokens so authorization never needs a database lookup.
type Permission string

// The permission catalog (docs/02-architecture.md, section 5.1).
const (
	PermProjectView         Permission = "project.view"
	PermProjectViewFinished Permission = "project.view_finished"
	PermProjectCreate       Permission = "project.create"
	PermProjectUpdate       Permission = "project.update"
	PermProjectFinish       Permission = "project.finish"
	PermProjectDelete       Permission = "project.delete"
	PermParticipantView     Permission = "participant.view"
	PermParticipantEdit     Permission = "participant.edit"
	PermParticipantPrint    Permission = "participant.print"
	PermParticipantExport   Permission = "participant.export"
	PermParticipantImport   Permission = "participant.import"
	PermParticipantDelete   Permission = "participant.delete"
	PermParticipantClear    Permission = "participant.clear"
	PermParticipantFollow   Permission = "participant.follow"
	PermUserView           Permission = "user.view"
	PermUserManage          Permission = "user.manage"
	PermRoleManage          Permission = "role.manage"
	PermAuditView           Permission = "audit.view"
	PermSystemView          Permission = "system.view"
)

// Permission group names shown in the admin panel.
const (
	GroupProjects       = "Projects"
	GroupParticipants   = "Participants"
	GroupAdministration = "Administration"
)

// PermissionInfo describes one catalog entry.
type PermissionInfo struct {
	Code        Permission
	Group       string
	Description string
}

// catalog is ordered; the order is the canonical order of permission lists.
var catalog = []PermissionInfo{
	{PermProjectView, GroupProjects, "View active projects, open them, read the image and placeholders"},
	{PermProjectViewFinished, GroupProjects, "View finished projects (read-only)"},
	{PermProjectCreate, GroupProjects, "Create projects"},
	{PermProjectUpdate, GroupProjects, "Edit title, image, placeholders and ticket settings"},
	{PermProjectFinish, GroupProjects, "Finish projects and return them to active"},
	{PermProjectDelete, GroupProjects, "Delete projects permanently"},
	{PermParticipantView, GroupParticipants, "View the participants table"},
	{PermParticipantEdit, GroupParticipants, "Edit cells and add rows"},
	{PermParticipantPrint, GroupParticipants, "Print, save and copy ticket images (printing is audited)"},
	{PermParticipantExport, GroupParticipants, "Export participants to XLSX or CSV"},
	{PermParticipantImport, GroupParticipants, "Import participants from XLSX or CSV"},
	{PermParticipantDelete, GroupParticipants, "Delete rows"},
	{PermParticipantClear, GroupParticipants, "Clear all participants of a project"},
	{PermParticipantFollow, GroupParticipants, "Follow a colleague: highlight their row and move along with them"},
	{PermUserView, GroupAdministration, "View the list of users"},
	{PermUserManage, GroupAdministration, "Create, edit and deactivate users, reset passwords"},
	{PermRoleManage, GroupAdministration, "Create, edit and delete roles and assign them to users (effectively full administrator)"},
	{PermAuditView, GroupAdministration, "View the audit log"},
	{PermSystemView, GroupAdministration, "View the system status"},
}

// requires maps a permission to the permissions it cannot work without. The
// server adds missing dependencies when a role is saved. Entries need not be
// transitive; NormalizePermissions closes the relation.
var requires = map[Permission][]Permission{
	PermProjectViewFinished: {PermProjectView},
	PermProjectCreate:       {PermProjectView},
	PermProjectUpdate:       {PermProjectView},
	PermProjectFinish:       {PermProjectView},
	PermProjectDelete:       {PermProjectView},
	PermParticipantView:     {PermProjectView},
	PermParticipantEdit:     {PermParticipantView},
	PermParticipantPrint:    {PermParticipantView},
	PermParticipantExport:   {PermParticipantView},
	PermParticipantImport:   {PermParticipantView},
	PermParticipantDelete:   {PermParticipantView},
	PermParticipantClear:    {PermParticipantView},
	PermParticipantFollow:   {PermParticipantView},
	PermUserManage:          {PermUserView},
	PermRoleManage:          {PermUserView},
}

// Catalog returns a copy of the permission catalog in canonical order.
func Catalog() []PermissionInfo { return slices.Clone(catalog) }

// AllPermissions returns every catalog code in canonical order. The admin role
// always holds exactly this set.
func AllPermissions() []Permission {
	out := make([]Permission, len(catalog))
	for i, p := range catalog {
		out[i] = p.Code
	}
	return out
}

// DefaultWorkerPermissions returns the default permission set of the worker role.
func DefaultWorkerPermissions() []Permission {
	return []Permission{
		PermProjectView,
		PermProjectViewFinished,
		PermParticipantView,
		PermParticipantEdit,
		PermParticipantPrint,
		PermParticipantExport,
	}
}

// Known reports whether p is in the catalog.
func (p Permission) Known() bool {
	return slices.ContainsFunc(catalog, func(i PermissionInfo) bool { return i.Code == p })
}

// Requires returns the direct dependencies of p.
func (p Permission) Requires() []Permission { return slices.Clone(requires[p]) }

// NormalizePermissions validates a requested permission list and returns it
// with duplicates removed, every missing (transitive) dependency added, and
// the result in canonical catalog order. Unknown codes are rejected with a
// ValidationError on the "permissions" field; input is never mutated.
func NormalizePermissions(in []string) ([]Permission, error) {
	want := make(map[Permission]bool, len(in))
	var unknown []FieldError
	for _, code := range in {
		p := Permission(code)
		if !p.Known() {
			unknown = append(unknown, FieldError{Field: "permissions", Reason: fmt.Sprintf("unknown permission %q", code)})
			continue
		}
		want[p] = true
	}
	if len(unknown) > 0 {
		return nil, NewValidation(unknown...)
	}
	// Dependencies form a shallow DAG; iterate to a fixed point.
	for changed := true; changed; {
		changed = false
		for p := range want {
			for _, dep := range requires[p] {
				if !want[dep] {
					want[dep] = true
					changed = true
				}
			}
		}
	}
	out := make([]Permission, 0, len(want))
	for _, info := range catalog {
		if want[info.Code] {
			out = append(out, info.Code)
		}
	}
	return out, nil
}
