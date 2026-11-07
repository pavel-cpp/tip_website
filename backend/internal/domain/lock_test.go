package domain

import (
	"errors"
	"testing"
	"time"
)

func TestLockConstants(t *testing.T) {
	if LockTTL != 45*time.Second || LockHeartbeat != 15*time.Second {
		t.Fatal("lock timings drifted from docs/02-architecture.md")
	}
	if LockHeartbeat*2 >= LockTTL {
		t.Fatal("heartbeat must allow missing at least one beat")
	}
}

func TestRowLockExpiry(t *testing.T) {
	l := NewRowLock("r1", "u1", t0)
	if !l.ExpiresAt.Equal(t0.Add(LockTTL)) || l.RowID != "r1" || l.UserID != "u1" {
		t.Fatalf("lock = %+v", l)
	}
	tests := []struct {
		name    string
		at      time.Time
		expired bool
	}{
		{"just granted", t0, false},
		{"one nanosecond before", t0.Add(LockTTL - time.Nanosecond), false},
		{"exact boundary", t0.Add(LockTTL), true},
		{"after", t0.Add(LockTTL + time.Second), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if l.Expired(tt.at) != tt.expired {
				t.Fatalf("Expired = %v", !tt.expired)
			}
		})
	}
}

func TestRowLockRenew(t *testing.T) {
	l := NewRowLock("r1", "u1", t0)
	renewed := l.Renew(t0.Add(15 * time.Second))
	if !renewed.ExpiresAt.Equal(t0.Add(15*time.Second + LockTTL)) {
		t.Fatalf("renewed expiry = %v", renewed.ExpiresAt)
	}
	if !l.ExpiresAt.Equal(t0.Add(LockTTL)) {
		t.Fatal("Renew must not mutate the receiver")
	}
	// A late or reordered heartbeat must not shorten the lock.
	if back := renewed.Renew(t0); !back.ExpiresAt.Equal(renewed.ExpiresAt) {
		t.Fatal("expiry moved backwards")
	}
}

func TestRowLockOwnership(t *testing.T) {
	l := NewRowLock("r1", "u1", t0)
	if !l.OwnedBy("u1") || l.OwnedBy("u2") || l.OwnedBy("") {
		t.Fatal("OwnedBy mismatch")
	}
	tests := []struct {
		name   string
		user   string
		at     time.Time
		locked bool
	}{
		{"owner passes", "u1", t0.Add(time.Second), false},
		{"other blocked", "u2", t0.Add(time.Second), true},
		{"other passes after expiry", "u2", t0.Add(LockTTL), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := l.EnsureAvailableTo(tt.user, tt.at)
			if !tt.locked {
				if err != nil {
					t.Fatalf("err = %v", err)
				}
				return
			}
			var de *Error
			if !errors.Is(err, ErrRowLocked) || !errors.As(err, &de) || de.Details["by"] != "u1" {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

func TestEvents(t *testing.T) {
	p := Participant{ID: "r1"}
	tests := []struct {
		name string
		ev   Event
		typ  EventType
	}{
		{"upsert", RowsUpserted(p), "rows.upsert"},
		{"delete", RowsDeleted("a", "b"), "rows.delete"},
		{"project", ProjectUpdated(Project{ID: "p"}), "project.updated"},
		{"reauth", Reauth("u1"), "reauth"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.ev.EventType() != tt.typ {
				t.Fatalf("type = %q", tt.ev.EventType())
			}
		})
	}
	if up := RowsUpserted(p); len(up.Items) != 1 || up.Items[0].ID != "r1" {
		t.Fatalf("upsert = %+v", up)
	}
	if del := RowsDeleted("a", "b"); len(del.IDs) != 2 {
		t.Fatalf("delete = %+v", del)
	}
	if ProjectUpdated(Project{ID: "p"}).Project.ID != "p" || Reauth("u1").UserID != "u1" {
		t.Fatal("constructor payloads wrong")
	}
}
