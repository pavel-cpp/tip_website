-- +goose Up
CREATE TYPE project_status AS ENUM ('active', 'finished');

CREATE TABLE projects (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    title        text           NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    status       project_status NOT NULL DEFAULT 'active',
    finished_at  timestamptz,
    -- image (file at uploads/projects/<sha256>); all fields are null or all are set
    image_sha256 text,
    image_name   text,
    image_mime   text,
    image_w      int,
    image_h      int,
    image_bytes  int,
    -- printing
    next_number  int            NOT NULL DEFAULT 1,     -- number counter; numbers are never reused
    version      int            NOT NULL DEFAULT 1,
    created_by   uuid           REFERENCES users ON DELETE SET NULL,
    created_at   timestamptz    NOT NULL DEFAULT now(),
    updated_at   timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT image_all_or_none CHECK (
        (image_sha256 IS NULL) = (image_w IS NULL) AND (image_w IS NULL) = (image_mime IS NULL))
);
CREATE INDEX projects_status_idx ON projects (status, created_at DESC);

-- Three rows per project: number | name | phone. A table (not jsonb) so CHECK constraints protect integrity.
CREATE TABLE project_placeholders (
    project_id   uuid     NOT NULL REFERENCES projects ON DELETE CASCADE,
    key          text     NOT NULL CHECK (key IN ('number', 'name', 'phone')),
    font         text     NOT NULL,                                  -- from the application allow-list
    size         int      NOT NULL CHECK (size BETWEEN 6 AND 400),
    stroke       int      NOT NULL DEFAULT 0 CHECK (stroke BETWEEN 0 AND 50),
    color        text     NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
    stroke_color text     NOT NULL CHECK (stroke_color ~ '^#[0-9a-fA-F]{6}$'),
    bold         boolean  NOT NULL DEFAULT false,
    italic       boolean  NOT NULL DEFAULT false,
    underline    boolean  NOT NULL DEFAULT false,
    x            int      NOT NULL CHECK (x >= 0),                   -- source image px, text center
    y            int      NOT NULL CHECK (y >= 0),
    PRIMARY KEY (project_id, key)
);

-- Who worked in the project (avatars on the card). Does NOT affect access.
CREATE TABLE project_contributors (
    project_id    uuid        NOT NULL REFERENCES projects ON DELETE CASCADE,
    user_id       uuid        NOT NULL REFERENCES users ON DELETE CASCADE,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_contributors_user_idx ON project_contributors (user_id);

-- +goose Down
DROP TABLE project_contributors;
DROP TABLE project_placeholders;
DROP TABLE projects;
DROP TYPE project_status;
