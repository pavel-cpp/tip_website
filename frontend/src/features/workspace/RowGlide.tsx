/**
 * Highlights of the table that glide instead of jumping: the selection, the current-row marker and the
 * row of a followed colleague. Each is one element (or one per run of rows) laid over the list and
 * positioned with `transform`, so moving the selection from one row to another slides it.
 * They only apply to the grid, where every row has the same height.
 */

export interface Run {
  start: number
  len: number
}

/** Contiguous stretches of selected rows, as indexes into the visible list. */
export function selectionRuns(ids: readonly string[], selected: ReadonlySet<string>): Run[] {
  const runs: Run[] = []
  if (selected.size === 0) return runs
  let open: Run | null = null
  for (let i = 0; i < ids.length; i++) {
    if (selected.has(ids[i] as string)) {
      if (open) open.len++
      else {
        open = { start: i, len: 1 }
        runs.push(open)
      }
    } else open = null
  }
  return runs
}

const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$/

interface BandsProps {
  runs: readonly Run[]
  /** The spotlighted row of a followed colleague, with that colleague's colour. */
  spot: { index: number; color: string } | null
  rowHeight: number
}

/** Under the rows: the selection fill and the followed colleague's row. */
export function UnderLayer({ runs, spot, rowHeight }: BandsProps) {
  return (
    <span className="pt-layer" aria-hidden="true">
      {runs.map((r, i) => (
        // A run keeps its element while it moves or stretches, so the change is a glide.
        <span
          key={i}
          className="pt-band"
          style={{ transform: `translateY(${r.start * rowHeight}px) scaleY(${r.len * rowHeight})` }}
        />
      ))}
      {spot && (
        <span
          className="pt-spot"
          style={{
            height: rowHeight - 1,
            transform: `translateY(${spot.index * rowHeight}px)`,
            // The colour comes from the server, so anything that is not a plain hex falls back to the accent.
            ['--spot' as string]: SAFE_COLOR.test(spot.color) ? spot.color : 'var(--accent)',
          }}
        />
      )}
    </span>
  )
}

/** Over the rows: the marker of the current row. */
export function CurrentMark({ index, rowHeight }: { index: number | null; rowHeight: number }) {
  if (index === null) return null
  return (
    <span
      className="pt-curmark"
      aria-hidden="true"
      style={{ height: rowHeight - 16, transform: `translateY(${index * rowHeight + 8}px)` }}
    />
  )
}
