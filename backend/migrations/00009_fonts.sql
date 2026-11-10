-- +goose Up
-- Uploaded ticket fonts. The file lives in the content-addressed store under sha256; a placeholder selects
-- it with the font value 'custom:<id>' (project_placeholders.font stays free text, validated by the service).
CREATE TABLE fonts (
    id         uuid        PRIMARY KEY DEFAULT uuidv7(),
    name       text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    format     text        NOT NULL CHECK (format IN ('ttf', 'otf', 'woff2')),
    sha256     text        NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    bytes      int         NOT NULL CHECK (bytes > 0),
    created_by uuid        REFERENCES users ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE fonts;
