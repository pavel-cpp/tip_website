-- +goose Up
-- Serves "the row this user edited last in this project" shown for colleagues who are not online.
CREATE INDEX participants_last_edit_idx ON participants (project_id, updated_by, updated_at DESC);

-- +goose Down
DROP INDEX participants_last_edit_idx;
