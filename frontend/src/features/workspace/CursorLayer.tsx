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
  /** Top of the strip and its height, in px from the top of the list. */
  y: number
  h: number
}

/**
 * Lays out the colleagues' cursors: one thin strip on the left edge of the row each colleague looks at.
 * A row shows a single cursor (the one of whoever pointed at it last), so the strip never crowds.
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
 * One element per colleague, keyed by person, so a strip glides from row to row instead of
 * disappearing and reappearing. Only `transform` changes: the 1px-tall element is stretched to `h`.
 */
export function CursorLayer({ items }: { items: readonly PlacedCursor[] }) {
  if (items.length === 0) return null
  return (
    <span className="pt-cursors" aria-hidden="true">
      {items.map((c) => (
        <span
          key={c.id}
          className="pt-cursor"
          style={{ background: c.color, transform: `translateY(${c.y}px) scaleY(${c.h})` }}
        />
      ))}
    </span>
  )
}
