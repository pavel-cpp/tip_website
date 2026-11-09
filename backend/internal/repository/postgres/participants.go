package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// ParticipantRepo stores participant rows in PostgreSQL. Every method joins the transaction
// carried by ctx, if any.
type ParticipantRepo struct{ db *sql.DB }

// NewParticipantRepo returns a repository over the pool.
func NewParticipantRepo(db *sql.DB) *ParticipantRepo { return &ParticipantRepo{db: db} }

const participantColumns = `p.id::text, p.project_id::text, p.number, p.name, p.phone, p.version,
	coalesce(p.updated_by::text, ''), p.updated_at`

type partRowScanner interface{ Scan(dest ...any) error }

func scanParticipant(s partRowScanner) (domain.Participant, error) {
	var p domain.Participant
	err := s.Scan(&p.ID, &p.ProjectID, &p.Number, &p.Name, &p.Phone, &p.Version, &p.UpdatedBy, &p.UpdatedAt)
	return p, err
}

// likePattern turns a user substring into an ILIKE pattern, escaping the wildcards.
func likePattern(q string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(q) + "%"
}

// filterClause returns the optional WHERE fragment and args for the substring filter q, with
// placeholders starting at $2 ($1 is always the project id).
func filterClause(q string) (string, []any) {
	if q == "" {
		return "", nil
	}
	return ` AND (p.name ILIKE $2 OR p.phone ILIKE $2 OR p.number::text = $3)`, []any{likePattern(q), q}
}

// List returns the project's rows ordered by number. A non-empty q keeps rows whose name or
// phone contains it (case-insensitive) or whose number equals it.
func (r *ParticipantRepo) List(ctx context.Context, projectID, q string) ([]domain.Participant, error) {
	clause, extra := filterClause(q)
	query := `SELECT ` + participantColumns + ` FROM participants p WHERE p.project_id = $1` + clause + ` ORDER BY p.number`
	rows, err := Querier(ctx, r.db).QueryContext(ctx, query, append([]any{projectID}, extra...)...)
	if err != nil {
		return nil, fmt.Errorf("list participants: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []domain.Participant
	for rows.Next() {
		p, err := scanParticipant(rows)
		if err != nil {
			return nil, fmt.Errorf("scan participant: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list participants: %w", err)
	}
	return out, nil
}

// Stamp summarizes the (optionally filtered) table so the service can build a revision and an
// ETag without reading the rows: any insert, edit or delete changes at least one value.
func (r *ParticipantRepo) Stamp(ctx context.Context, projectID, q string) (count int, versionSum int64, lastWrite time.Time, err error) {
	clause, extra := filterClause(q)
	query := `SELECT count(*), coalesce(sum(p.version), 0)::bigint, coalesce(max(p.updated_at), 'epoch'::timestamptz)
		FROM participants p WHERE p.project_id = $1` + clause
	err = Querier(ctx, r.db).QueryRowContext(ctx, query, append([]any{projectID}, extra...)...).
		Scan(&count, &versionSum, &lastWrite)
	if err != nil {
		return 0, 0, time.Time{}, fmt.Errorf("stamp participants: %w", err)
	}
	return count, versionSum, lastWrite, nil
}

// Count returns the number of rows of the project.
func (r *ParticipantRepo) Count(ctx context.Context, projectID string) (int, error) {
	var n int
	err := Querier(ctx, r.db).QueryRowContext(ctx, `SELECT count(*) FROM participants WHERE project_id = $1`, projectID).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count participants: %w", err)
	}
	return n, nil
}

// Get returns one row, or domain.ErrNotFound.
func (r *ParticipantRepo) Get(ctx context.Context, id string) (domain.Participant, error) {
	p, err := scanParticipant(Querier(ctx, r.db).QueryRowContext(ctx,
		`SELECT `+participantColumns+` FROM participants p WHERE p.id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Participant{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Participant{}, fmt.Errorf("get participant: %w", err)
	}
	return p, nil
}

// addRows allocates consecutive numbers and inserts the rows in one statement, so the counter
// bump and the inserts are atomic even outside an explicit transaction. The counter is only
// advanced for an active project: a finished project yields no row from the CTE.
const addRows = `
WITH alloc AS (
	UPDATE projects SET next_number = next_number + $2
	WHERE id = $1 AND status = 'active'
	RETURNING next_number - $2 AS first
)
INSERT INTO participants AS p (project_id, number, name, phone, updated_by, updated_at)
SELECT $1::uuid, alloc.first + t.ord - 1, t.name, t.phone, nullif($5, '')::uuid, $6
FROM alloc, unnest($3::text[], $4::text[]) WITH ORDINALITY AS t(name, phone, ord)
RETURNING ` + participantColumns

// Add inserts one row per draft (only Name and Phone are used) with freshly allocated
// numbers and returns the stored rows ordered by number. A missing project yields
// domain.ErrNotFound and a finished one domain.ErrProjectFinished; nothing is written then.
func (r *ParticipantRepo) Add(ctx context.Context, projectID string, drafts []domain.Participant, byUser string, now time.Time) ([]domain.Participant, error) {
	if len(drafts) == 0 {
		return nil, nil
	}
	names := make([]string, len(drafts))
	phones := make([]string, len(drafts))
	for i, d := range drafts {
		names[i], phones[i] = d.Name, d.Phone
	}
	q := Querier(ctx, r.db)
	rows, err := q.QueryContext(ctx, addRows, projectID, len(drafts), names, phones, byUser, now)
	if err != nil {
		return nil, fmt.Errorf("add participants: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make([]domain.Participant, 0, len(drafts))
	for rows.Next() {
		p, err := scanParticipant(rows)
		if err != nil {
			return nil, fmt.Errorf("scan participant: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("add participants: %w", err)
	}
	if len(out) == 0 {
		return nil, r.explainNoProject(ctx, q, projectID)
	}
	slices.SortFunc(out, func(a, b domain.Participant) int { return a.Number - b.Number })
	return out, nil
}

// AddEmpty inserts count blank rows; see Add for the numbering and error rules.
func (r *ParticipantRepo) AddEmpty(ctx context.Context, projectID string, count int, byUser string, now time.Time) ([]domain.Participant, error) {
	return r.Add(ctx, projectID, make([]domain.Participant, count), byUser, now)
}

// explainNoProject tells apart a missing project from a finished one after the allocation
// statement matched nothing.
func (r *ParticipantRepo) explainNoProject(ctx context.Context, q DBTX, projectID string) error {
	var status string
	err := q.QueryRowContext(ctx, `SELECT status::text FROM projects WHERE id = $1`, projectID).Scan(&status)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return domain.ErrNotFound
	case err != nil:
		return fmt.Errorf("check project status: %w", err)
	default:
		return domain.ErrProjectFinished
	}
}

// UpdateIfVersion stores name and phone of p, which already holds the NEW state as produced
// by Participant.Edited: p.Version is the new version, so the row is updated only while the
// stored version is p.Version-1. When nothing matches it returns domain.ErrVersionConflict
// (also for a row deleted meanwhile); the service then attaches the current row.
func (r *ParticipantRepo) UpdateIfVersion(ctx context.Context, p domain.Participant) (domain.Participant, error) {
	const q = `UPDATE participants p SET name = $2, phone = $3, version = $4,
			updated_by = nullif($5, '')::uuid, updated_at = $6
		WHERE p.id = $1 AND p.version = $4 - 1
		RETURNING ` + participantColumns
	out, err := scanParticipant(Querier(ctx, r.db).QueryRowContext(ctx, q,
		p.ID, p.Name, p.Phone, p.Version, p.UpdatedBy, p.UpdatedAt))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Participant{}, domain.ErrVersionConflict
	}
	if err != nil {
		return domain.Participant{}, fmt.Errorf("update participant: %w", err)
	}
	return out, nil
}

// updateMany applies many edits in one statement. A row is written only when its stored
// version equals the expected one, so stale edits simply do not appear in the result.
const updateMany = `
UPDATE participants p SET
	name = CASE WHEN v.set_name THEN v.name ELSE p.name END,
	phone = CASE WHEN v.set_phone THEN v.phone ELSE p.phone END,
	version = p.version + 1, updated_by = nullif($7, '')::uuid, updated_at = $8
FROM unnest($2::text[]::uuid[], $3::bool[], $4::bool[], $5::text[], $6::text[], $9::bigint[])
	AS v(id, set_name, set_phone, name, phone, version)
WHERE p.project_id = $1 AND p.id = v.id AND p.version = v.version
RETURNING ` + participantColumns

// UpdateMany applies the changes whose expected version still matches and returns the stored
// rows ordered by number; the others are silently left out (the caller detects them by id).
func (r *ParticipantRepo) UpdateMany(ctx context.Context, projectID string, changes []domain.ParticipantChange, byUser string, now time.Time) ([]domain.Participant, error) {
	n := len(changes)
	ids, setN, setP := make([]string, n), make([]bool, n), make([]bool, n)
	names, phones, vers := make([]string, n), make([]string, n), make([]int64, n)
	for i, c := range changes {
		ids[i], setN[i], setP[i], names[i], phones[i], vers[i] = c.ID, c.SetName, c.SetPhone, c.Name, c.Phone, int64(c.Version)
	}
	return r.queryRows(ctx, updateMany, projectID, ids, setN, setP, names, phones, byUser, now, vers)
}

// ClearByIDs empties name and phone of the given rows that are not empty yet, bumping their
// versions. Ids of other projects or unknown ids are ignored.
func (r *ParticipantRepo) ClearByIDs(ctx context.Context, projectID string, ids []string, byUser string, now time.Time) ([]domain.Participant, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	return r.queryRows(ctx, `UPDATE participants p SET name = '', phone = '', version = p.version + 1,
			updated_by = nullif($3, '')::uuid, updated_at = $4
		WHERE p.project_id = $1 AND p.id = ANY($2::text[]::uuid[]) AND (p.name <> '' OR p.phone <> '')
		RETURNING `+participantColumns, projectID, ids, byUser, now)
}

// ListByIDs returns the given rows of the project ordered by number.
func (r *ParticipantRepo) ListByIDs(ctx context.Context, projectID string, ids []string) ([]domain.Participant, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	return r.queryRows(ctx, `SELECT `+participantColumns+` FROM participants p
		WHERE p.project_id = $1 AND p.id = ANY($2::text[]::uuid[])`, projectID, ids)
}

func (r *ParticipantRepo) queryRows(ctx context.Context, query string, args ...any) ([]domain.Participant, error) {
	rows, err := Querier(ctx, r.db).QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query participants: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []domain.Participant
	for rows.Next() {
		p, err := scanParticipant(rows)
		if err != nil {
			return nil, fmt.Errorf("scan participant: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("query participants: %w", err)
	}
	slices.SortFunc(out, func(a, b domain.Participant) int { return a.Number - b.Number })
	return out, nil
}
