/** Neighbour of the current row in the visible order; null at either end or when nothing is shown. */
export function stepRow<T extends { id: string }>(
  rows: readonly T[],
  currentId: string | null,
  dir: -1 | 1,
): T | null {
  if (rows.length === 0) return null
  const i = rows.findIndex((r) => r.id === currentId)
  // Without a current row the first arrow press lands on the first or the last row.
  if (i < 0) return (dir > 0 ? rows[0] : rows[rows.length - 1]) ?? null
  return rows[i + dir] ?? null
}
