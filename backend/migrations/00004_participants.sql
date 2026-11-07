-- +goose Up
CREATE TABLE participants (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    project_id uuid               NOT NULL REFERENCES projects ON DELETE CASCADE,
    number     int                NOT NULL CHECK (number > 0),
    name       text               NOT NULL DEFAULT '' CHECK (char_length(name)  <= 200),
    phone      text               NOT NULL DEFAULT '' CHECK (char_length(phone) <= 40),
    version    int                NOT NULL DEFAULT 1,            -- optimistic concurrency
    updated_by uuid               REFERENCES users ON DELETE SET NULL,
    created_at timestamptz        NOT NULL DEFAULT now(),
    updated_at timestamptz        NOT NULL DEFAULT now(),
    UNIQUE (project_id, number)                                   -- also serves as the per-project lookup index
);
-- Search by name/phone: a project has up to ~20k rows and the client filters locally, so a server-side ILIKE
-- over the project_id index is enough. If needed, add a pg_trgm GIN (name, phone) index in a separate migration.

-- Number allocation is atomic:
--   UPDATE projects SET next_number = next_number + $n WHERE id = $1 RETURNING next_number - $n AS first;
--   INSERT INTO participants (project_id, number) SELECT $1, g FROM generate_series($first, $first+$n-1) g;

-- +goose Down
DROP TABLE participants;
