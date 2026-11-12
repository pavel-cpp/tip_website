import type { RowCursor } from './presence'

/** More colleagues than this on one row still fit the strip. */
export const MAX_SEGMENTS = 8
const GAP = 1
const MIN_SEGMENT = 3

/** Where a row sits inside the list, in px from its top. */
export interface CursorSlot {
  start: number
  size: number
}

export interface PlacedCursor {
  id: string
  color: string
  /** Top of the segment and its height, in px from the top of the list. */
  y: number
  h: number
}

/**
 * Lays out the colleagues' cursors: on every row one thin strip split into one segment per person.
 * The width never changes, so any number of cursors stays inside the row.
 */
export function placeCursors(
  byRow: ReadonlyMap<string, readonly RowCursor[]>,
  slotOf: (rowId: string) => CursorSlot | null,
  inset: { top: number; bottom: number },
): PlacedCursor[] {
  const out: PlacedCursor[] = []
  for (const [rowId, list] of byRow) {
    const slot = slotOf(rowId)
    if (!slot) continue
    // A stable order keeps a person's segment from swapping places with another when someone moves.
    const people = [...list].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, MAX_SEGMENTS)
    const room = Math.max(MIN_SEGMENT, slot.size - inset.top - inset.bottom)
    const h = Math.max(MIN_SEGMENT, (room - (people.length - 1) * GAP) / people.length)
    people.forEach((p, i) => {
      out.push({ id: p.id, color: p.color, y: slot.start + inset.top + i * (h + GAP), h })
    })
  }
  // Moving a DOM node cancels its transition, so the elements keep one order whatever rows people are on.
  return out.sort((a, b) => (a.id < b.id ? -1 : 1))
}

/**
 * One element per colleague, keyed by person, so a segment glides from row to row instead of
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
