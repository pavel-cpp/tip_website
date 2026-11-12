import type { RowCursor } from './presence'

/** More colleagues than this on one row still fit the strip; the tooltip names all of them. */
const MAX_SEGMENTS = 8

/**
 * Colleagues who are looking at a row: a thin strip on the row's left edge split into one coloured
 * segment per person. The width never changes, so any number of cursors stays inside the row.
 */
export function CursorStrip({ cursors }: { cursors: readonly RowCursor[] }) {
  if (cursors.length === 0) return null
  return (
    <span className="pt-cursors" aria-hidden="true" title={cursors.map((c) => c.displayName).join(', ')}>
      {cursors.slice(0, MAX_SEGMENTS).map((c) => (
        <span key={c.id} className="pt-cursor" style={{ background: c.color }} />
      ))}
    </span>
  )
}
