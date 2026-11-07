-- +goose Up
CREATE TABLE users (
    id                   uuid PRIMARY KEY DEFAULT uuidv7(),
    login                text        NOT NULL UNIQUE
                         CHECK (login ~ '^[a-z0-9._-]{3,32}$'),            -- always lower case
    display_name         text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
    color                text        NOT NULL DEFAULT '#6cb4ff' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
    locale               text        NOT NULL DEFAULT 'ru'   CHECK (locale IN ('ru', 'uz')),
    theme                text        NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light', 'system')),
    -- argon2id PHC string: irreversible hash with salt and parameters (the password itself is never stored)
    password_hash        text        NOT NULL,
    -- the password was issued by the server (create / reset): the UI recommends changing it; does not block work
    password_temporary   boolean     NOT NULL DEFAULT true,
    is_active            boolean     NOT NULL DEFAULT true,
    last_login_at        timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Avatar up to 256x256 JPEG (~20-40 KB) lives in the database: same transaction, same dump.
CREATE TABLE user_avatars (
    user_id    uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
    mime       text        NOT NULL,
    data       bytea       NOT NULL CHECK (octet_length(data) <= 262144),
    sha256     text        NOT NULL,            -- for ETag and ?v=
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- There are no token tables: access and refresh tokens are JWTs (HS256); their state
-- (refresh allow-list, revocation) lives only in Redis.

-- +goose Down
DROP TABLE user_avatars;
DROP TABLE users;
