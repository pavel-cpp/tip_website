package domain

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
)

func TestPaletteColor(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		id := fmt.Sprintf("0192f6c0-0000-7000-8000-%012d", i)
		c := PaletteColor(id)
		if c != PaletteColor(id) {
			t.Fatalf("colour of %s is not stable", id)
		}
		if err := ValidateColor("color", c); err != nil {
			t.Fatalf("invalid palette colour %q: %v", c, err)
		}
		seen[c] = true
	}
	if len(seen) != len(UserPalette) {
		t.Fatalf("200 ids used %d of %d palette colours", len(seen), len(UserPalette))
	}
}

func TestNormalizeLogin(t *testing.T) {
	tests := []struct {
		name, in, want string
		ok             bool
	}{
		{"lowercase kept", "alice", "alice", true},
		{"upper folded", "Alice.B", "alice.b", true},
		{"trimmed", "  bob_1  ", "bob_1", true},
		{"all allowed chars", "a-b_c.9", "a-b_c.9", true},
		{"min length", "abc", "abc", true},
		{"max length", strings.Repeat("a", 32), strings.Repeat("a", 32), true},
		{"too short", "ab", "", false},
		{"too long", strings.Repeat("a", 33), "", false},
		{"space inside", "a b c", "", false},
		{"cyrillic", "тест123", "", false},
		{"at sign", "a@b.c", "", false},
		{"empty", "", "", false},
		{"whitespace only", "   ", "", false},
		{"newline injection", "abc\nxyz", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := NormalizeLogin(tt.in)
			if tt.ok != (err == nil) || got != tt.want {
				t.Fatalf("got (%q, %v), want (%q, ok=%v)", got, err, tt.want, tt.ok)
			}
			if err != nil && !errors.Is(err, ErrValidation) {
				t.Fatalf("error must be VALIDATION: %v", err)
			}
		})
	}
}

func TestNormalizeDisplayName(t *testing.T) {
	tests := []struct {
		name, in, want string
		ok             bool
	}{
		{"plain", "Alice", "Alice", true},
		{"trimmed", "  Alice  ", "Alice", true},
		{"unicode counts runes", strings.Repeat("Ш", 80), strings.Repeat("Ш", 80), true},
		{"too long runes", strings.Repeat("Ш", 81), "", false},
		{"empty", "", "", false},
		{"blank", "   ", "", false},
		{"control char", "Al\x00ice", "", false},
		{"tab inside", "Al\tice", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := NormalizeDisplayName(tt.in)
			if tt.ok != (err == nil) || got != tt.want {
				t.Fatalf("got (%q, %v)", got, err)
			}
		})
	}
}

func TestValidateColor(t *testing.T) {
	tests := []struct {
		in string
		ok bool
	}{
		{"#6cb4ff", true}, {"#FFFFFF", true}, {"#aAbBcC", true},
		{"6cb4ff", false}, {"#fff", false}, {"#6cb4fg", false}, {"#6cb4ff0", false}, {"", false}, {" #6cb4ff", false},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			err := ValidateColor("color", tt.in)
			if (err == nil) != tt.ok {
				t.Fatalf("err = %v", err)
			}
		})
	}
	if err := ValidateColor("userColor", "x"); err == nil || !strings.Contains(err.Error(), "userColor") {
		t.Fatalf("field name missing from error: %v", err)
	}
}

func TestParseLocaleAndTheme(t *testing.T) {
	for _, in := range []string{"ru", "uz"} {
		if l, err := ParseLocale(in); err != nil || string(l) != in {
			t.Errorf("locale %q: %v %v", in, l, err)
		}
	}
	for _, in := range []string{"", "en", "RU", " ru"} {
		if _, err := ParseLocale(in); !errors.Is(err, ErrValidation) {
			t.Errorf("locale %q must be rejected", in)
		}
	}
	for _, in := range []string{"dark", "light", "system"} {
		if th, err := ParseTheme(in); err != nil || string(th) != in {
			t.Errorf("theme %q: %v %v", in, th, err)
		}
	}
	for _, in := range []string{"", "blue", "Dark"} {
		if _, err := ParseTheme(in); !errors.Is(err, ErrValidation) {
			t.Errorf("theme %q must be rejected", in)
		}
	}
	if DefaultLocale != LocaleRU || DefaultTheme != ThemeDark {
		t.Fatal("defaults must match the schema")
	}
	if err := ValidateColor("color", DefaultColor); err != nil {
		t.Fatalf("default colour invalid: %v", err)
	}
}

func TestEnsureAdminRemains(t *testing.T) {
	tests := []struct {
		name           string
		admins, losing int
		wantLast       bool
	}{
		{"nobody lost", 1, 0, false},
		{"two admins lose one", 2, 1, false},
		{"one admin loses one", 1, 1, true},
		{"two admins lose both", 2, 2, true},
		{"three lose two", 3, 2, false},
		{"zero admins nobody lost", 0, 0, false},
		{"zero admins lose one", 0, 1, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := EnsureAdminRemains(tt.admins, tt.losing)
			if tt.wantLast != errors.Is(err, ErrLastAdmin) {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

func TestUserIsAdmin(t *testing.T) {
	if (User{Roles: []RoleRef{{Name: "worker"}}}).IsAdmin() {
		t.Fatal("worker is not admin")
	}
	if !(User{Roles: []RoleRef{{Name: "worker"}, {Name: RoleAdmin}}}).IsAdmin() {
		t.Fatal("admin role not detected")
	}
}

func TestValidatePassword(t *testing.T) {
	tests := []struct {
		name, in string
		ok       bool
	}{
		{"8 ascii", "12345678", true},
		{"long", strings.Repeat("x", 200), true},
		{"7 chars", "1234567", false},
		{"empty", "", false},
		{"8 runes multibyte", "пароль12", true},
		{"7 runes multibyte", "пароль1", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidatePassword("new", tt.in)
			if (err == nil) != tt.ok {
				t.Fatalf("err = %v", err)
			}
			if err != nil && !strings.Contains(err.Error(), "new") {
				t.Fatalf("field missing: %v", err)
			}
		})
	}
}

func TestNormalizeRoleInput(t *testing.T) {
	long := strings.Repeat("d", 301)
	tests := []struct {
		name       string
		rname      string
		desc       string
		perms      []string
		wantFields []string
	}{
		{"ok", "Senior", "desc", []string{"participant.edit"}, nil},
		{"min name", "ab", "", nil, nil},
		{"short name", "a", "", nil, []string{"name"}},
		{"blank name", "  ", "", nil, []string{"name"}},
		{"long name", strings.Repeat("n", 51), "", nil, []string{"name"}},
		{"long desc", "Okay", long, nil, []string{"description"}},
		{"unknown perm", "Okay", "", []string{"nope.nope"}, []string{"permissions"}},
		{"all wrong", "x", long, []string{"nope.nope"}, []string{"name", "description", "permissions"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			in, err := NormalizeRoleInput(tt.rname, tt.desc, tt.perms)
			if len(tt.wantFields) == 0 {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if in.Name != strings.TrimSpace(tt.rname) {
					t.Fatalf("name = %q", in.Name)
				}
				return
			}
			var ve *ValidationError
			if !errors.As(err, &ve) {
				t.Fatalf("err = %v", err)
			}
			var got []string
			for _, f := range ve.Fields {
				got = append(got, f.Field)
			}
			if !slices.Equal(got, tt.wantFields) {
				t.Fatalf("fields = %v, want %v", got, tt.wantFields)
			}
		})
	}

	in, err := NormalizeRoleInput("  Senior ", "  d ", []string{"participant.delete"})
	if err != nil || in.Name != "Senior" || in.Description != "d" ||
		!slices.Equal(in.Permissions, []Permission{PermProjectView, PermParticipantView, PermParticipantDelete}) {
		t.Fatalf("normalization failed: %+v %v", in, err)
	}
}

func TestRoleRules(t *testing.T) {
	admin := Role{ID: "1", Name: RoleAdmin, IsSystem: true}
	worker := Role{ID: "2", Name: RoleWorker, IsSystem: true, Permissions: DefaultWorkerPermissions()}
	custom := Role{ID: "3", Name: "Custom"}

	for _, r := range []Role{admin, worker} {
		if !errors.Is(r.CheckDeletable(), ErrRoleSystem) {
			t.Errorf("%s must not be deletable", r.Name)
		}
	}
	if custom.CheckDeletable() != nil {
		t.Error("custom role must be deletable")
	}
	if !admin.IsAdminRole() || worker.IsAdminRole() || (Role{Name: RoleAdmin}).IsAdminRole() {
		t.Error("IsAdminRole mismatch")
	}

	in := RoleInput{Name: "X1", Description: "d", Permissions: []Permission{PermProjectView}}

	if _, err := admin.Edited(in); !errors.Is(err, ErrRoleSystem) {
		t.Errorf("admin edit = %v", err)
	}
	if _, err := worker.Edited(in); !errors.Is(err, ErrValidation) {
		t.Errorf("worker rename = %v", err)
	}
	in.Name = RoleWorker
	got, err := worker.Edited(in)
	if err != nil || got.Description != "d" || len(got.Permissions) != 1 || got.ID != "2" || !got.IsSystem {
		t.Errorf("worker edit = %+v %v", got, err)
	}
	in.Name = "Renamed"
	got, err = custom.Edited(in)
	if err != nil || got.Name != "Renamed" {
		t.Errorf("custom edit = %+v %v", got, err)
	}
}
