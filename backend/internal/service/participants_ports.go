package service

import (
	"context"
	"io"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// ParticipantRepo is the participant storage used by Participants. Implemented by
// repository/postgres.ParticipantRepo; every method joins the transaction carried by ctx.
type ParticipantRepo interface {
	// List returns the project's rows ordered by number; a non-empty q keeps rows whose
	// name or phone contains it (case-insensitive) or whose number equals it.
	List(ctx context.Context, projectID, q string) ([]domain.Participant, error)
	// Stamp summarizes the same (filtered) set without reading the rows; any insert, edit or
	// delete changes at least one returned value.
	Stamp(ctx context.Context, projectID, q string) (count int, versionSum int64, lastWrite time.Time, err error)
	// Count returns the number of rows of the project.
	Count(ctx context.Context, projectID string) (int, error)
	// Get returns one row or domain.ErrNotFound.
	Get(ctx context.Context, id string) (domain.Participant, error)
	// Add inserts one row per draft (Name and Phone only) with atomically allocated numbers
	// and returns them ordered by number. A finished project yields domain.ErrProjectFinished.
	Add(ctx context.Context, projectID string, drafts []domain.Participant, byUser string, now time.Time) ([]domain.Participant, error)
	// AddEmpty is Add with count blank rows.
	AddEmpty(ctx context.Context, projectID string, count int, byUser string, now time.Time) ([]domain.Participant, error)
	// UpdateIfVersion stores p, which holds the new state from Participant.Edited, only while
	// the stored version is p.Version-1; otherwise it returns domain.ErrVersionConflict.
	UpdateIfVersion(ctx context.Context, p domain.Participant) (domain.Participant, error)
	// DeleteByIDs deletes the given rows of the project and returns the ids actually removed.
	DeleteByIDs(ctx context.Context, projectID string, ids []string) ([]string, error)
	// Clear deletes every row of the project and returns the removed ids.
	Clear(ctx context.Context, projectID string) ([]string, error)
}

// ProjectReader gives Participants read access to projects. It is implemented by the
// projects area; Get returns domain.ErrNotFound for an unknown id. Visibility rules are applied
// by Participants itself from the actor's permissions.
type ProjectReader interface {
	Get(ctx context.Context, id string) (domain.Project, error)
}

// ParticipantLocks exposes the realtime row locks (held in memory by the Hub). The realtime
// area implements it, typically as a thin adapter over its RowLocks.
type ParticipantLocks interface {
	// LockOf returns the current lock on a row, if any. An expired lock may be returned;
	// the caller checks expiry through domain.RowLock.
	LockOf(rowID string) (domain.RowLock, bool)
}

// ParticipantNotifier publishes realtime events to the project's room. Publishing never
// blocks and never fails the request: delivery problems are the Hub's concern.
type ParticipantNotifier interface {
	Publish(projectID string, ev domain.Event)
}

// SheetCodec reads and writes participant tables. Implemented by platform/sheets.Codec; its
// signatures use only standard types so that package needs no knowledge of the service.
type SheetCodec interface {
	// Read parses an XLSX or CSV (detected from the content) and calls emit for every
	// non-empty data row with its 1-based line in the file. More than maxRows rows yield
	// domain.ErrTooLarge, unreadable content a validation or unsupported-media error.
	Read(r io.Reader, maxRows int, emit func(line int, name, phone string) error) error
	// Write encodes rows as FormatXLSX or FormatCSV with the columns number, name, phone.
	Write(w io.Writer, format string, rows []domain.Participant) error
}
