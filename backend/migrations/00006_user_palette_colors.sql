-- +goose Up
-- Users created before palette assignment all share the column default; spread them over the six-colour
-- palette deterministically (stable per id, so a re-run on the same data gives the same result).
UPDATE users
SET color = (ARRAY['#ff6b9d', '#ffb84d', '#3ddc97', '#6cb4ff', '#b18cff', '#ff9559'])[1 + ((hashtext(id::text)::bigint & 2147483647) % 6)::int]
WHERE color = '#6cb4ff';

-- +goose Down
-- The previous colours are not recoverable (they were all the default); the Down step is deliberately a no-op.
SELECT 1;
