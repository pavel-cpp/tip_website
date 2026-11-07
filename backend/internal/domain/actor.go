package domain

import (
	"slices"
	"time"
)

// PermissionSet is a set of permissions; the zero value is an empty set.
type PermissionSet map[Permission]struct{}

// NewPermissionSet builds a set from the given permissions.
func NewPermissionSet(perms ...Permission) PermissionSet {
	s := make(PermissionSet, len(perms))
	for _, p := range perms {
		s[p] = struct{}{}
	}
	return s
}

// Has reports whether the set contains p.
func (s PermissionSet) Has(p Permission) bool {
	_, ok := s[p]
	return ok
}

// Sorted returns the members in canonical catalog order, with any unknown
// codes appended alphabetically. Used to build deterministic token claims.
func (s PermissionSet) Sorted() []Permission {
	out := make([]Permission, 0, len(s))
	for _, info := range catalog {
		if s.Has(info.Code) {
			out = append(out, info.Code)
		}
	}
	var extra []Permission
	for p := range s {
		if !p.Known() {
			extra = append(extra, p)
		}
	}
	slices.Sort(extra)
	return append(out, extra...)
}

// Actor is the authenticated caller, assembled by the transport layer from the
// claims of a verified access token and passed to services explicitly. All
// authorization decisions use Perms; no database lookup happens per request.
type Actor struct {
	UserID string
	Roles  []string
	Perms  PermissionSet
	// TokenID, Family, TokenExp and Epoch mirror the jti, fam, exp and pe claims
	// of the access token the request arrived with.
	TokenID  string
	Family   string
	TokenExp time.Time
	Epoch    int64
}

// Can reports whether the actor holds permission p.
func (a Actor) Can(p Permission) bool { return a.Perms.Has(p) }

// Require returns ErrForbidden unless the actor holds permission p.
func (a Actor) Require(p Permission) error {
	if a.Can(p) {
		return nil
	}
	return ErrForbidden
}

// HasRole reports whether the actor was granted the named role.
func (a Actor) HasRole(name string) bool { return slices.Contains(a.Roles, name) }
