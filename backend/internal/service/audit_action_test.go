package service

import (
	"context"
	"testing"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

func TestAuditListPassesActionFilter(t *testing.T) {
	st := &fakeAuditStore{}
	s := newAudit(st, AuditConfig{})
	admin := ptActorWith("a", domain.PermAuditView)

	if _, err := s.List(context.Background(), admin, AuditQuery{Action: "user.create"}); err != nil {
		t.Fatal(err)
	}
	if len(st.listed) != 1 || st.listed[0].Action != "user.create" {
		t.Fatalf("filter = %+v", st.listed)
	}
}
