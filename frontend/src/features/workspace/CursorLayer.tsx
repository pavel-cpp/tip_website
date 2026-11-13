import type { RowCursor } from './presence'

const MIN_SEGMENT = 3

/** Where a row sits inside the list, in px from its top. */
export interface CursorSlot {
  start: number
  size: number
}

export interface PlacedCursor {
  id: string
  color: string
  /** Top of the marker and its height, in px from the top of the list. */
  y: number
  h: number
}

/**
 * Lays out the colleagues' cursors. A colleague's cursor is drawn like your own current-row marker (same
 * width, height and rounding) and stands to the right of it. A row shows a single colleague (the one who
 * pointed at it last), so with you and two others on one row you see your marker and that colleague's.
 */
export function placeCursors(
  byRow: ReadonlyMap<string, RowCursor>,
  slotOf: (rowId: string) => CursorSlot | null,
  inset: { top: number; bottom: number },
): PlacedCursor[] {
  const out: PlacedCursor[] = []
  for (const [rowId, cursor] of byRow) {
    const slot = slotOf(rowId)
    if (!slot) continue
    const h = Math.max(MIN_SEGMENT, slot.size - inset.top - inset.bottom)
    out.push({ id: cursor.id, color: cursor.color, y: slot.start + inset.top, h })
  }
  // Moving a DOM node cancels its transition, so the elements keep one order whatever rows people are on.
  return out.sort((a, b) => (a.id < b.id ? -1 : 1))
}

/**
 * One element per colleague, keyed by person, so a marker glides from row to row instead of
 * disappearing and reappearing. Only `transform` changes while it moves; the height is the row's.
 */
export function CursorLayer({ items }: { items: readonly PlacedCursor[] }) {
  if (items.length === 0) return null
  return (
    <span className="pt-cursors" aria-hidden="true">
      {items.map((c) => (
        <span
          key={c.id}
          className="pt-cursor"
          style={{ background: c.color, height: c.h, transform: `translateY(${c.y}px)` }}
        />
      ))}
    </span>
  )
}
