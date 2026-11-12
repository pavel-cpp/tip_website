package domain

import (
	"errors"
	"reflect"
	"regexp"
	"slices"
	"testing"
	"time"
)

func TestCatalogIntegrity(t *testing.T) {
	codePattern := regexp.MustCompile(`^[a-z_]+\.[a-z_]+$`) // same CHECK as the permissions table
	seen := map[Permission]bool{}
	for _, info := range Catalog() {
		if !codePattern.MatchString(string(info.Code)) {
			t.Errorf("code %q violates the schema CHECK", info.Code)
		}
		if seen[info.Code] {
			t.Errorf("duplicate code %q", info.Code)
		}
		seen[info.Code] = true
		if info.Group == "" || info.Description == "" {
			t.Errorf("%s: group and description are required", info.Code)
		}
	}
	if len(seen) != 19 {
		t.Errorf("catalog size = %d, want 19", len(seen))
	}
	// Every dependency must itself be a catalog member.
	for p, deps := range requires {
		if !p.Known() {
			t.Errorf("requires key %q not in catalog", p)
		}
		for _, d := range deps {
			if !d.Known() {
				t.Errorf("%s requires unknown %q", p, d)
			}
		}
	}
}

func TestCatalogReturnsCopy(t *testing.T) {
	c := Catalog()
	c[0].Group = "mutated"
	if Catalog()[0].Group == "mutated" {
		t.Fatal("Catalog must return a copy")
	}
}

func TestDefaultWorkerPermissionsAreClosed(t *testing.T) {
	def := DefaultWorkerPermissions()
	want := []Permission{PermProjectView, PermProjectViewFinished, PermParticipantView,
		PermParticipantEdit, PermParticipantPrint, PermParticipantExport}
	if !reflect.DeepEqual(def, want) {
		t.Fatalf("defaults = %v", def)
	}
	strs := make([]string, len(def))
	for i, p := range def {
		strs[i] = string(p)
	}
	norm, err := NormalizePermissions(strs)
	if err != nil || !slices.Equal(norm, def) {
		t.Fatalf("defaults must already be dependency-closed: %v %v", norm, err)
	}
}

func TestNormalizePermissions(t *testing.T) {
	tests := []struct {
		name string
		in   []string
		want []Permission
	}{
		{"empty", nil, []Permission{}},
		{"single without deps", []string{"project.view"}, []Permission{PermProjectView}},
		{"edit pulls view and project", []string{"participant.edit"},
			[]Permission{PermProjectView, PermParticipantView, PermParticipantEdit}},
		{"dedupe and order", []string{"participant.print", "participant.print", "project.view"},
			[]Permission{PermProjectView, PermParticipantView, PermParticipantPrint}},
		{"finished needs project.view", []string{"project.view_finished"},
			[]Permission{PermProjectView, PermProjectViewFinished}},
		{"project writes", []string{"project.update", "project.finish", "project.delete", "project.create"},
			[]Permission{PermProjectView, PermProjectCreate, PermProjectUpdate, PermProjectFinish, PermProjectDelete}},
		{"participant ops", []string{"participant.export", "participant.import", "participant.delete", "participant.clear"},
			[]Permission{PermProjectView, PermParticipantView, PermParticipantExport, PermParticipantImport,
				PermParticipantDelete, PermParticipantClear}},
		{"user.manage needs user.view", []string{"user.manage"}, []Permission{PermUserView, PermUserManage}},
		{"role.manage needs user.view", []string{"role.manage"}, []Permission{PermUserView, PermRoleManage}},
		{"independent admin perms", []string{"system.view", "audit.view"}, []Permission{PermAuditView, PermSystemView}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := NormalizePermissions(tt.in)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !slices.Equal(got, tt.want) {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestNormalizePermissionsAllIsStable(t *testing.T) {
	all := AllPermissions()
	strs := make([]string, len(all))
	for i, p := range all {
		strs[i] = string(p)
	}
	got, err := NormalizePermissions(strs)
	if err != nil || !slices.Equal(got, all) {
		t.Fatalf("normalizing the full catalog must be identity: %v", err)
	}
}

func TestNormalizePermissionsRejectsUnknown(t *testing.T) {
	in := []string{"project.view", "bogus.perm", "Project.View", ""}
	_, err := NormalizePermissions(in)
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("err = %v", err)
	}
	var ve *ValidationError
	if !errors.As(err, &ve) || len(ve.Fields) != 3 {
		t.Fatalf("want 3 field errors, got %+v", ve)
	}
}

func TestNormalizePermissionsDoesNotMutateInput(t *testing.T) {
	in := []string{"participant.edit"}
	_, _ = NormalizePermissions(in)
	if len(in) != 1 {
		t.Fatal("input mutated")
	}
}

func TestPermissionRequiresReturnsCopy(t *testing.T) {
	r := PermParticipantEdit.Requires()
	if len(r) != 1 || r[0] != PermParticipantView {
		t.Fatalf("Requires = %v", r)
	}
	r[0] = PermSystemView
	if PermParticipantEdit.Requires()[0] != PermParticipantView {
		t.Fatal("Requires must return a copy")
	}
}

func TestPermissionSet(t *testing.T) {
	s := NewPermissionSet(PermSystemView, PermProjectView, "zzz.custom", "aaa.custom")
	if !s.Has(PermProjectView) || s.Has(PermAuditView) {
		t.Fatal("Has mismatch")
	}
	want := []Permission{PermProjectView, PermSystemView, "aaa.custom", "zzz.custom"}
	if got := s.Sorted(); !slices.Equal(got, want) {
		t.Fatalf("Sorted = %v, want %v", got, want)
	}
	var nilSet PermissionSet
	if nilSet.Has(PermProjectView) {
		t.Fatal("nil set must be empty")
	}
}

func TestActorCanRequire(t *testing.T) {
	a := Actor{UserID: "u1", Roles: []string{"worker"}, Perms: NewPermissionSet(PermParticipantEdit)}
	tests := []struct {
		perm Permission
		can  bool
	}{
		{PermParticipantEdit, true},
		{PermParticipantDelete, false},
		{"unknown.perm", false},
	}
	for _, tt := range tests {
		t.Run(string(tt.perm), func(t *testing.T) {
			if a.Can(tt.perm) != tt.can {
				t.Fatalf("Can = %v", !tt.can)
			}
			err := a.Require(tt.perm)
			if tt.can && err != nil {
				t.Fatalf("Require = %v", err)
			}
			if !tt.can && !errors.Is(err, ErrForbidden) {
				t.Fatalf("Require = %v, want FORBIDDEN", err)
			}
		})
	}
	if !a.HasRole("worker") || a.HasRole("admin") {
		t.Fatal("HasRole mismatch")
	}
	if (Actor{}).Can(PermProjectView) {
		t.Fatal("zero actor must have no permissions")
	}
}

func TestClaimsToActor(t *testing.T) {
	now := time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC)
	c := AccessClaims{
		Subject: "u1", Roles: []string{"worker"}, Perms: []Permission{PermProjectView},
		PermEpoch: 3, TokenID: "j", Family: "f", IssuedAt: now, ExpiresAt: now.Add(15 * time.Minute), Type: TokenAccess,
	}
	a := c.Actor()
	if a.UserID != "u1" || !a.Can(PermProjectView) || a.TokenID != "j" || a.Family != "f" ||
		a.Epoch != 3 || !a.TokenExp.Equal(c.ExpiresAt) {
		t.Fatalf("actor = %+v", a)
	}
	c.Roles[0] = "mutated"
	if a.Roles[0] != "worker" {
		t.Fatal("actor must not alias claims roles")
	}

	if c.Expired(now) || !c.Expired(c.ExpiresAt) || !c.Expired(c.ExpiresAt.Add(time.Second)) {
		t.Fatal("Expired boundary wrong")
	}
	if c.Stale(3) || c.Stale(2) || !c.Stale(4) {
		t.Fatal("Stale mismatch")
	}
	r := RefreshClaims{ExpiresAt: now}
	if r.Expired(now.Add(-time.Nanosecond)) || !r.Expired(now) {
		t.Fatal("refresh Expired boundary wrong")
	}
}
