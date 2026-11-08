-- +goose Up
-- Users that share a palette colour are spread over the palette. Users are visited oldest first; a user
-- keeps the colour unless an older user already holds it and some palette colour has fewer holders, in which
-- case the user moves to the least-used colour (ties go to the earlier palette entry). Colours picked by hand
-- (outside the palette) are never touched. The result depends only on created_at and id, so a re-run is a no-op.
-- +goose StatementBegin
DO $$
DECLARE
  palette text[] := ARRAY['#ff6b9d', '#ffb84d', '#3ddc97', '#6cb4ff', '#b18cff', '#ff9559'];
  counts int[] := ARRAY[0, 0, 0, 0, 0, 0];
  u record;
  cur int;
  best int;
  i int;
BEGIN
  FOR u IN SELECT id, lower(color) AS color FROM users ORDER BY created_at, id LOOP
    cur := array_position(palette, u.color);
    IF cur IS NULL THEN
      CONTINUE;
    END IF;
    best := 1;
    FOR i IN 2..6 LOOP
      IF counts[i] < counts[best] THEN
        best := i;
      END IF;
    END LOOP;
    IF counts[cur] > counts[best] THEN
      UPDATE users SET color = palette[best] WHERE id = u.id;
      cur := best;
    END IF;
    counts[cur] := counts[cur] + 1;
  END LOOP;
END
$$;
-- +goose StatementEnd

-- +goose Down
-- The previous colours are not recoverable; the Down step is deliberately a no-op.
SELECT 1;
