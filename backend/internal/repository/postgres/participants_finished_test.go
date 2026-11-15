package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// Every participant write must be refused once the project is finished, even when the caller checked
// the status earlier (the service reads it without a lock).
func TestParticipantWritesRefusedAfterFinish(t *testing.T) {
	d := newMigratedDB(t)
	r := NewParticipantRepo(d)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	proj := seedProject(t, d, "active")
	rows, err := r.Add(ctx, proj, []domain.Participant{{Name: "Azam", Phone: "1"}, {Name: "Ali", Phone: "2"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.ExecContext(ctx, `UPDATE projects SET status = 'finished', finished_at = now() WHERE id = $1`, proj); err != nil {
		t.Fatal(err)
	}

	edited, err := rows[0].Edited("Changed", "9", rows[0].Version, "", now)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		run  func() error
	}{
		{"UpdateIfVersion", func() error { _, err := r.UpdateIfVersion(ctx, edited); return err }},
		{"UpdateMany", func() error {
			_, err := r.UpdateMany(ctx, proj, []domain.ParticipantChange{
				{ID: rows[1].ID, SetName: true, Name: "X", Version: rows[1].Version},
			}, "", now)
			return err
		}},
		{"ClearByIDs", func() error { _, err := r.ClearByIDs(ctx, proj, []string{rows[0].ID, rows[1].ID}, "", now); return err }},
		{"Add", func() error { _, err := r.AddEmpty(ctx, proj, 1, "", now); return err }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.run(); !errors.Is(err, domain.ErrProjectFinished) {
				t.Fatalf("err = %v, want ErrProjectFinished", err)
			}
		})
	}

	got, err := r.List(ctx, proj, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Name != "Azam" || got[0].Version != 1 || got[1].Name != "Ali" || got[1].Version != 1 {
		t.Fatalf("rows changed after finish: %+v", got)
	}
}

// A stale version on an active project is still a version conflict, not a finished-project error.
func TestParticipantUpdateStillReportsVersionConflict(t *testing.T) {
	d := newMigratedDB(t)
	r := NewParticipantRepo(d)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	proj := seedProject(t, d, "active")
	rows, err := r.Add(ctx, proj, []domain.Participant{{Name: "Azam"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	stale := rows[0]
	stale.Version = 5 // expects stored version 4
	if _, err := r.UpdateIfVersion(ctx, stale); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("err = %v, want ErrVersionConflict", err)
	}
	if got, err := r.UpdateMany(ctx, proj, []domain.ParticipantChange{{ID: rows[0].ID, SetName: true, Name: "X", Version: 9}}, "", now); err != nil || len(got) != 0 {
		t.Fatalf("stale batch = %v, %v", got, err)
	}
}

// The status check must wait for a Finish that is in flight: a write that started before Finish committed
// must not land after it.
func TestParticipantWriteWaitsForConcurrentFinish(t *testing.T) {
	d := newMigratedDB(t)
	r := NewParticipantRepo(d)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	proj := seedProject(t, d, "active")
	rows, err := r.Add(ctx, proj, []domain.Participant{{Name: "Azam"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}

	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `UPDATE projects SET status = 'finished', finished_at = now() WHERE id = $1`, proj); err != nil {
		t.Fatal(err)
	}

	res := make(chan error, 1)
	go func() {
		_, err := r.UpdateMany(ctx, proj, []domain.ParticipantChange{{ID: rows[0].ID, SetName: true, Name: "Late", Version: rows[0].Version}}, "", now)
		res <- err
	}()
	select {
	case err := <-res:
		t.Fatalf("write did not wait for the in-flight Finish: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-res:
		if !errors.Is(err, domain.ErrProjectFinished) {
			t.Fatalf("err = %v, want ErrProjectFinished", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("write still blocked after Finish committed")
	}
	got, err := r.Get(ctx, rows[0].ID)
	if err != nil || got.Name != "Azam" {
		t.Fatalf("row = %+v, %v", got, err)
	}
}

// A malformed id is "not found", not an internal error (the WebSocket path used to log it at ERROR).
func TestProjectAndParticipantGetMalformedID(t *testing.T) {
	d := newMigratedDB(t)
	ctx := context.Background()
	if _, err := NewProjectRepo(d).Get(ctx, "not-a-uuid"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("project: %v", err)
	}
	if _, err := NewParticipantRepo(d).Get(ctx, "not-a-uuid"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("participant: %v", err)
	}
}
