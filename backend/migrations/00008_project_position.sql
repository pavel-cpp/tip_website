-- +goose Up
-- Team-wide manual order of projects: a smaller position is shown first. Positions are not
-- required to be unique or gap-free; ties fall back to the old newest-first order.
ALTER TABLE projects ADD COLUMN position bigint NOT NULL DEFAULT 0;

-- Keep the order users already see: newest first.
UPDATE projects p SET position = r.n
FROM (SELECT id, row_number() OVER (ORDER BY created_at DESC, id DESC) AS n FROM projects) r
WHERE p.id = r.id;

CREATE INDEX projects_position_idx ON projects (position, created_at DESC);

-- +goose Down
DROP INDEX projects_position_idx;
ALTER TABLE projects DROP COLUMN position;
