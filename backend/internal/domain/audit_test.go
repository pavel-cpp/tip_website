package domain

import "testing"

func TestAuditConstants(t *testing.T) {
	if AuditPurgeBatch != 5000 || DefaultAuditRetentionDays != 30 || DefaultAuditMaxRows != 100_000 {
		t.Fatal("audit retention defaults drifted from docs/03-database.md")
	}
	if ActionTicketsPrint != "tickets.print" {
		t.Fatalf("unexpected action name %q", ActionTicketsPrint)
	}
}
