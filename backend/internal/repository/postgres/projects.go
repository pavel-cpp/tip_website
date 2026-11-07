package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// ProjectRepo stores projects, their placeholders and contributors in PostgreSQL.
type ProjectRepo struct{ db DBTX }

// NewProjectRepo returns a repository over the pool.
func NewProjectRepo(db DBTX) *ProjectRepo { return &ProjectRepo{db: db} }

const projectColumns = `id, title, status::text, finished_at, image_sha256, image_name, image_mime,
	image_w, image_h, image_bytes, next_number, version, COALESCE(created_by::text, ''), created_at, updated_at`

type rowScanner interface{ Scan(dest ...any) error }

func scanProject(row rowScanner) (domain.Project, error) {
	var (
		p                       domain.Project
		status                  string
		finished                sql.NullTime
		sha, name, mime         sql.NullString
		width, height, imgBytes sql.NullInt32
	)
	err := row.Scan(&p.ID, &p.Title, &status, &finished, &sha, &name, &mime,
		&width, &height, &imgBytes, &p.NextNumber, &p.Version, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return domain.Project{}, err
	}
	p.Status = domain.ProjectStatus(status)
	if finished.Valid {
		t := finished.Time
		p.FinishedAt = &t
	}
	if sha.Valid {
		p.Image = &domain.ImageMeta{
			SHA256: sha.String, Name: name.String, Mime: mime.String,
			Width: int(width.Int32), Height: int(height.Int32), Bytes: int(imgBytes.Int32),
		}
	}
	return p, nil
}

// Create inserts the project and its three placeholder rows.
func (r *ProjectRepo) Create(ctx context.Context, p domain.Project) error {
	q := Querier(ctx, r.db)
	_, err := q.ExecContext(ctx, `
		INSERT INTO projects (id, title, status, next_number, version, created_by, created_at, updated_at)
		VALUES ($1, $2, $3::project_status, $4, $5, NULLIF($6, '')::uuid, $7, $8)`,
		p.ID, p.Title, string(p.Status), p.NextNumber, p.Version, p.CreatedBy, p.CreatedAt, p.UpdatedAt)
	if err != nil {
		return fmt.Errorf("insert project: %w", err)
	}
	for _, key := range domain.PlaceholderKeys {
		ph, _ := p.Placeholders.Get(key)
		_, err := q.ExecContext(ctx, `
			INSERT INTO project_placeholders
				(project_id, key, font, size, stroke, color, stroke_color, bold, italic, underline, x, y)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
			p.ID, string(key), ph.Font, ph.Size, ph.Stroke, ph.Color, ph.StrokeColor, ph.Bold, ph.Italic, ph.Underline, ph.X, ph.Y)
		if err != nil {
			return fmt.Errorf("insert placeholder %s: %w", key, err)
		}
	}
	return nil
}

// Get returns the project with its placeholders, or domain.ErrNotFound.
func (r *ProjectRepo) Get(ctx context.Context, id string) (domain.Project, error) {
	return r.get(ctx, id, "")
}

// GetForUpdate is Get with a row lock held until the surrounding transaction ends.
func (r *ProjectRepo) GetForUpdate(ctx context.Context, id string) (domain.Project, error) {
	return r.get(ctx, id, " FOR UPDATE")
}

func (r *ProjectRepo) get(ctx context.Context, id, lock string) (domain.Project, error) {
	q := Querier(ctx, r.db)
	p, err := scanProject(q.QueryRowContext(ctx, `SELECT `+projectColumns+` FROM projects WHERE id = $1`+lock, id))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Project{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Project{}, fmt.Errorf("select project: %w", err)
	}
	rows, err := q.QueryContext(ctx, `
		SELECT key, font, size, stroke, color, stroke_color, bold, italic, underline, x, y
		FROM project_placeholders WHERE project_id = $1`, id)
	if err != nil {
		return domain.Project{}, fmt.Errorf("select placeholders: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var key string
		var ph domain.Placeholder
		if err := rows.Scan(&key, &ph.Font, &ph.Size, &ph.Stroke, &ph.Color, &ph.StrokeColor,
			&ph.Bold, &ph.Italic, &ph.Underline, &ph.X, &ph.Y); err != nil {
			return domain.Project{}, fmt.Errorf("scan placeholder: %w", err)
		}
		switch domain.PlaceholderKey(key) {
		case domain.PlaceholderNumber:
			p.Placeholders.Number = ph
		case domain.PlaceholderName:
			p.Placeholders.Name = ph
		case domain.PlaceholderPhone:
			p.Placeholders.Phone = ph
		}
	}
	if err := rows.Err(); err != nil {
		return domain.Project{}, fmt.Errorf("read placeholders: %w", err)
	}
	return p, nil
}

// Save writes title, status, image metadata, placeholders and version when the stored version
// equals expectedVersion. The caller passes the project with the already incremented version.
func (r *ProjectRepo) Save(ctx context.Context, p domain.Project, expectedVersion int) error {
	q := Querier(ctx, r.db)
	var sha, name, mime sql.NullString
	var w, h, n sql.NullInt32
	if p.Image != nil {
		sha = sql.NullString{String: p.Image.SHA256, Valid: true}
		name = sql.NullString{String: p.Image.Name, Valid: true}
		mime = sql.NullString{String: p.Image.Mime, Valid: true}
		w = sql.NullInt32{Int32: int32(p.Image.Width), Valid: true}  //nolint:gosec // bounded by MaxImagePixels
		h = sql.NullInt32{Int32: int32(p.Image.Height), Valid: true} //nolint:gosec // bounded by MaxImagePixels
		n = sql.NullInt32{Int32: int32(p.Image.Bytes), Valid: true}  //nolint:gosec // bounded by MaxImageBytes
	}
	res, err := q.ExecContext(ctx, `
		UPDATE projects SET title = $2, status = $3::project_status, finished_at = $4,
			image_sha256 = $5, image_name = $6, image_mime = $7, image_w = $8, image_h = $9, image_bytes = $10,
			version = $11, updated_at = $12
		WHERE id = $1 AND version = $13`,
		p.ID, p.Title, string(p.Status), p.FinishedAt, sha, name, mime, w, h, n, p.Version, p.UpdatedAt, expectedVersion)
	if err != nil {
		return fmt.Errorf("update project: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("update project: %w", err)
	}
	if affected == 0 {
		var one int
		err := q.QueryRowContext(ctx, `SELECT 1 FROM projects WHERE id = $1`, p.ID).Scan(&one)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("check project: %w", err)
		}
		return domain.ErrVersionConflict
	}
	for _, key := range domain.PlaceholderKeys {
		ph, _ := p.Placeholders.Get(key)
		_, err := q.ExecContext(ctx, `
			UPDATE project_placeholders SET font = $3, size = $4, stroke = $5, color = $6, stroke_color = $7,
				bold = $8, italic = $9, underline = $10, x = $11, y = $12
			WHERE project_id = $1 AND key = $2`,
			p.ID, string(key), ph.Font, ph.Size, ph.Stroke, ph.Color, ph.StrokeColor, ph.Bold, ph.Italic, ph.Underline, ph.X, ph.Y)
		if err != nil {
			return fmt.Errorf("update placeholder %s: %w", key, err)
		}
	}
	return nil
}

// Delete removes the project; placeholders, contributors and participants cascade.
func (r *ProjectRepo) Delete(ctx context.Context, id string) error {
	res, err := Querier(ctx, r.db).ExecContext(ctx, `DELETE FROM projects WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("delete project: %w", err)
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return domain.ErrNotFound
	}
	return nil
}

// likeEscaper neutralises LIKE wildcards in user input.
var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// List returns projects newest first. The placeholders are not loaded: the list only needs the
// card fields.
func (r *ProjectRepo) List(ctx context.Context, f domain.ProjectFilter) ([]domain.Project, error) {
	var status any
	if f.Status != nil {
		status = string(*f.Status)
	}
	rows, err := Querier(ctx, r.db).QueryContext(ctx, `
		SELECT `+projectColumns+` FROM projects
		WHERE ($1::text IS NULL OR status::text = $1)
		  AND ($2 = '' OR title ILIKE '%' || $2 || '%' ESCAPE '\')
		ORDER BY created_at DESC, id DESC`, status, likeEscaper.Replace(f.Query))
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []domain.Project
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, fmt.Errorf("scan project: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	return out, nil
}

// Details loads contributors (most recently active first) and participant counts.
func (r *ProjectRepo) Details(ctx context.Context, ids []string, maxContributors int) (map[string]domain.ProjectDetails, error) {
	q := Querier(ctx, r.db)
	out := make(map[string]domain.ProjectDetails, len(ids))
	for _, id := range ids {
		out[id] = domain.ProjectDetails{}
	}

	counts, err := q.QueryContext(ctx, `
		SELECT project_id::text, count(*) FROM participants WHERE project_id = ANY($1::uuid[]) GROUP BY project_id`, ids)
	if err != nil {
		return nil, fmt.Errorf("count participants: %w", err)
	}
	defer func() { _ = counts.Close() }()
	for counts.Next() {
		var id string
		var n int
		if err := counts.Scan(&id, &n); err != nil {
			return nil, fmt.Errorf("scan participant count: %w", err)
		}
		d := out[id]
		d.ParticipantCount = n
		out[id] = d
	}
	if err := counts.Err(); err != nil {
		return nil, fmt.Errorf("count participants: %w", err)
	}

	rows, err := q.QueryContext(ctx, `
		SELECT c.project_id::text, u.id::text, u.display_name, u.color, COALESCE(a.sha256, '')
		FROM project_contributors c
		JOIN users u ON u.id = c.user_id
		LEFT JOIN user_avatars a ON a.user_id = u.id
		WHERE c.project_id = ANY($1::uuid[])
		ORDER BY c.project_id, c.last_seen_at DESC, u.id`, ids)
	if err != nil {
		return nil, fmt.Errorf("select contributors: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var pid string
		var u domain.Contributor
		if err := rows.Scan(&pid, &u.ID, &u.DisplayName, &u.Color, &u.AvatarSHA); err != nil {
			return nil, fmt.Errorf("scan contributor: %w", err)
		}
		d := out[pid]
		if len(d.Contributors) < maxContributors {
			d.Contributors = append(d.Contributors, u)
			out[pid] = d
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("select contributors: %w", err)
	}
	return out, nil
}

// TouchContributor registers the user as a contributor or refreshes the last-seen time.
func (r *ProjectRepo) TouchContributor(ctx context.Context, projectID, userID string, at time.Time) error {
	if userID == "" {
		return nil
	}
	_, err := Querier(ctx, r.db).ExecContext(ctx, `
		INSERT INTO project_contributors (project_id, user_id, first_seen_at, last_seen_at)
		VALUES ($1, $2, $3, $3)
		ON CONFLICT (project_id, user_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
		projectID, userID, at)
	if err != nil {
		return fmt.Errorf("upsert contributor: %w", err)
	}
	return nil
}

// CountImageRefs returns the number of projects whose image has the given hash.
func (r *ProjectRepo) CountImageRefs(ctx context.Context, sha string) (int, error) {
	var n int
	err := Querier(ctx, r.db).QueryRowContext(ctx, `SELECT count(*) FROM projects WHERE image_sha256 = $1`, sha).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count image refs: %w", err)
	}
	return n, nil
}

// ReferencedImageHashes returns the set of image hashes used by projects.
func (r *ProjectRepo) ReferencedImageHashes(ctx context.Context) (map[string]struct{}, error) {
	rows, err := Querier(ctx, r.db).QueryContext(ctx, `SELECT DISTINCT image_sha256 FROM projects WHERE image_sha256 IS NOT NULL`)
	if err != nil {
		return nil, fmt.Errorf("select image hashes: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]struct{}{}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, fmt.Errorf("scan image hash: %w", err)
		}
		out[s] = struct{}{}
	}
	return out, rows.Err()
}
