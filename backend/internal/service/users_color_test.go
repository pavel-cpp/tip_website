package service

import (
	"fmt"
	"testing"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

func TestCreateUserPicksLeastUsedColor(t *testing.T) {
	r := newRig(t, rigOpts{})
	mgr := acctActorWith("u-admin", domain.PermUserManage)
	count := func(c string) int {
		n := 0
		for _, u := range r.db.users {
			if u.Color == c {
				n++
			}
		}
		return n
	}
	seeded := len(r.db.users)
	var got []string
	for i := 0; i < len(domain.UserPalette)*2; i++ {
		c, err := r.users.CreateUser(ctx, mgr, CreateUserInput{Login: fmt.Sprintf("color%02d", i), DisplayName: "C"})
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, c.Profile.User.Color)
	}
	lo, hi := 1<<30, 0
	for _, c := range domain.UserPalette {
		lo, hi = min(lo, count(c)), max(hi, count(c))
	}
	// Every pick is a least-used colour, so the spread never exceeds what the seed data started with.
	if hi-lo > seeded {
		t.Fatalf("colours %v are unbalanced: min %d max %d", got, lo, hi)
	}
	if got[0] == domain.DefaultColor {
		t.Fatalf("first user took the already used colour %s", got[0])
	}
}

func TestCreateUserKeepsExplicitColor(t *testing.T) {
	r := newRig(t, rigOpts{})
	mgr := acctActorWith("u-admin", domain.PermUserManage)
	c, err := r.users.CreateUser(ctx, mgr, CreateUserInput{Login: "picky", DisplayName: "P", Color: "#123456"})
	if err != nil || c.Profile.User.Color != "#123456" {
		t.Fatalf("color = %q err=%v", c.Profile.User.Color, err)
	}
}

func TestEnsureAdminCreatesWithFirstPaletteColor(t *testing.T) {
	r := newRig(t, rigOpts{})
	if _, err := r.users.EnsureAdmin(ctx, "boss", "boss-password"); err != nil {
		t.Fatal(err)
	}
	for _, u := range r.db.users {
		if u.Login == "boss" && u.Color != domain.UserPalette[0] {
			t.Fatalf("bootstrap admin colour = %q", u.Color)
		}
	}
}

func TestAccountAuditRecordsTargetLogin(t *testing.T) {
	r := newRig(t, rigOpts{})
	mgr := acctActorWith("u-admin", domain.PermUserManage)
	c, err := r.users.CreateUser(ctx, mgr, CreateUserInput{Login: "target.one", DisplayName: "T"})
	if err != nil {
		t.Fatal(err)
	}
	off := false
	if _, err := r.users.UpdateUser(ctx, mgr, c.Profile.User.ID, UserUpdate{IsActive: &off}); err != nil {
		t.Fatal(err)
	}
	if len(r.audit.entries) < 2 {
		t.Fatalf("entries = %v", r.audit.actions())
	}
	for _, e := range r.audit.entries {
		if e.TargetID == c.Profile.User.ID && e.Meta["login"] != "target.one" {
			t.Fatalf("%s entry lacks the target login: %v", e.Action, e.Meta)
		}
	}
}
