-- +goose Up
-- The permission catalog is defined by code (domain/permission.go); tipd upserts it here on start
-- so the admin panel can show it and role_permissions can reference existing codes.
CREATE TABLE permissions (
    code        text PRIMARY KEY CHECK (code ~ '^[a-z_]+\.[a-z_]+$'),     -- 'participant.edit'
    grp         text NOT NULL,                                            -- UI group: 'Projects', 'Participants', ...
    description text NOT NULL
);

CREATE TABLE roles (
    id          uuid PRIMARY KEY DEFAULT uuidv7(),
    name        text        NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 2 AND 50),
    description text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
    is_system   boolean     NOT NULL DEFAULT false,     -- admin, worker: cannot be deleted; admin cannot be edited
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
    role_id    uuid NOT NULL REFERENCES roles ON DELETE CASCADE,
    permission text NOT NULL REFERENCES permissions ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission)
);

-- A user may have several roles; effective permissions are their union.
CREATE TABLE user_roles (
    user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES roles ON DELETE RESTRICT,   -- an assigned role cannot be deleted (ROLE_IN_USE)
    PRIMARY KEY (user_id, role_id)
);
CREATE INDEX user_roles_role_idx ON user_roles (role_id);

-- Permission epoch: grows on any change of roles, permissions or assignments. An access JWT with a lower
-- epoch (claim pe) is rejected with 401 TOKEN_STALE and transparently refreshed. Single row; a copy is kept in process memory.
CREATE TABLE authz_state (
    id    smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    epoch bigint   NOT NULL DEFAULT 1
);
INSERT INTO authz_state DEFAULT VALUES;

-- System roles. Permissions of admin and the default permissions of worker are set by SyncPermissions on first start
-- (admin always gets the whole catalog; worker gets the default set only while the role has no permissions yet).
INSERT INTO roles (name, description, is_system) VALUES
    ('admin',  'Full access. Permissions are synchronized with the catalog automatically.', true),
    ('worker', 'Operator: works with participants and prints. Permissions can be changed.',  true);

-- +goose Down
DROP TABLE authz_state;
DROP TABLE user_roles;
DROP TABLE role_permissions;
DROP TABLE roles;
DROP TABLE permissions;
