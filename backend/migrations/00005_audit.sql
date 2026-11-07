-- +goose Up
-- The server disk is only 10 GB, so the audit is kept briefly: AUDIT_RETENTION_DAYS (30) and AUDIT_MAX_ROWS (100000),
-- whichever comes first. About 300 bytes per row, under 60 MB with indexes. Only changes and only IDs (no personal data).
CREATE TABLE audit_log (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at         timestamptz NOT NULL DEFAULT now(),
    actor_id   uuid        REFERENCES users ON DELETE SET NULL,
    actor_login text       NOT NULL,                 -- snapshot: the login stays readable after the user is deleted
    action     text        NOT NULL,                 -- 'user.create', 'project.finish', 'tickets.print', ...
    project_id uuid        REFERENCES projects ON DELETE SET NULL,
    entity_id  uuid,
    meta       jsonb       NOT NULL DEFAULT '{}',    -- IDs and numbers only; NO names or phones
    ip         inet
);
CREATE INDEX audit_at_idx      ON audit_log (at DESC);
CREATE INDEX audit_project_idx ON audit_log (project_id, at DESC) WHERE project_id IS NOT NULL;

-- +goose Down
DROP TABLE audit_log;
