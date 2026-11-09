package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// FontRepo stores uploaded font metadata; the files live in the blob store.
type FontRepo struct{ db DBTX }

// NewFontRepo returns a repository over the pool.
func NewFontRepo(db DBTX) *FontRepo { return &FontRepo{db: db} }

const fontColumns = `id::text, name, format, sha256, bytes, COALESCE(created_by::text, ''), created_at`

func scanFont(row rowScanner) (domain.Font, error) {
	var f domain.Font
	err := row.Scan(&f.ID, &f.Name, &f.Format, &f.SHA256, &f.Bytes, &f.CreatedBy, &f.CreatedAt)
	return f, err
}

// Create inserts the font.
func (r *FontRepo) Create(ctx context.Context, f domain.Font) error {
	_, err := Querier(ctx, r.db).ExecContext(ctx, `
		INSERT INTO fonts (id, name, format, sha256, bytes, created_by, created_at)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6, '')::uuid, $7)`,
		f.ID, f.Name, f.Format, f.SHA256, f.Bytes, f.CreatedBy, f.CreatedAt)
	if err != nil {
		return fmt.Errorf("insert font: %w", err)
	}
	return nil
}

// List returns every font, newest first.
func (r *FontRepo) List(ctx context.Context) ([]domain.Font, error) {
	rows, err := Querier(ctx, r.db).QueryContext(ctx, `SELECT `+fontColumns+` FROM fonts ORDER BY created_at DESC, id DESC`)
	if err != nil {
		return nil, fmt.Errorf("select fonts: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []domain.Font{}
	for rows.Next() {
		f, err := scanFont(rows)
		if err != nil {
			return nil, fmt.Errorf("scan font: %w", err)
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (r *FontRepo) one(ctx context.Context, where string, arg any) (domain.Font, error) {
	f, err := scanFont(Querier(ctx, r.db).QueryRowContext(ctx, `SELECT `+fontColumns+` FROM fonts WHERE `+where, arg))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Font{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Font{}, fmt.Errorf("select font: %w", err)
	}
	return f, nil
}

// Get returns the font or domain.ErrNotFound.
func (r *FontRepo) Get(ctx context.Context, id string) (domain.Font, error) {
	return r.one(ctx, `id = $1::uuid`, id)
}

// GetBySHA returns the font with that content hash or domain.ErrNotFound.
func (r *FontRepo) GetBySHA(ctx context.Context, sha string) (domain.Font, error) {
	return r.one(ctx, `sha256 = $1`, sha)
}

// Delete removes the font; domain.ErrNotFound when it does not exist.
func (r *FontRepo) Delete(ctx context.Context, id string) error {
	res, err := Querier(ctx, r.db).ExecContext(ctx, `DELETE FROM fonts WHERE id = $1::uuid`, id)
	if err != nil {
		return fmt.Errorf("delete font: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return domain.ErrNotFound
	}
	return nil
}

// Usage returns the number of fonts and their total size.
func (r *FontRepo) Usage(ctx context.Context) (int, int64, error) {
	var n int
	var total int64
	err := Querier(ctx, r.db).QueryRowContext(ctx, `SELECT count(*), COALESCE(sum(bytes), 0) FROM fonts`).Scan(&n, &total)
	if err != nil {
		return 0, 0, fmt.Errorf("font usage: %w", err)
	}
	return n, total, nil
}

// InUse reports whether any project placeholder uses the font.
func (r *FontRepo) InUse(ctx context.Context, id string) (bool, error) {
	var used bool
	err := Querier(ctx, r.db).QueryRowContext(ctx,
		`SELECT EXISTS (SELECT 1 FROM project_placeholders WHERE font = $1)`, domain.CustomFontRef(id)).Scan(&used)
	if err != nil {
		return false, fmt.Errorf("font in use: %w", err)
	}
	return used, nil
}

// Exists reports whether a font with that id exists.
func (r *FontRepo) Exists(ctx context.Context, id string) (bool, error) {
	var ok bool
	err := Querier(ctx, r.db).QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM fonts WHERE id = $1::uuid)`, id).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("font exists: %w", err)
	}
	return ok, nil
}

// Hashes returns the content hash of every font.
func (r *FontRepo) Hashes(ctx context.Context) (map[string]struct{}, error) {
	rows, err := Querier(ctx, r.db).QueryContext(ctx, `SELECT sha256 FROM fonts`)
	if err != nil {
		return nil, fmt.Errorf("select font hashes: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]struct{}{}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, fmt.Errorf("scan font hash: %w", err)
		}
		out[s] = struct{}{}
	}
	return out, rows.Err()
}
