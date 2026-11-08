import type { Participant, ParticipantInput } from './api'

/** Grid columns in display order. Only `name` and `phone` are editable; `number` is assigned by the server. */
export const COLUMNS = ['number', 'name', 'phone'] as const
export type Column = (typeof COLUMNS)[number]
export const EDITABLE: readonly Column[] = ['name', 'phone']
export const MAX_ADD_ROWS = 5000

export interface Cell {
  row: number
  col: number
}

const digits = (s: string) => s.replace(/\D/g, '')

/** Case-insensitive substring match on name and phone; digits-only queries also match formatted phones. */
export function filterRows(rows: readonly Participant[], query: string): readonly Participant[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  const qd = digits(q)
  const phoneByDigits = qd.length > 0 && qd === q.replace(/[\s()+-]/g, '')
  return rows.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      r.phone.toLowerCase().includes(q) ||
      (phoneByDigits && digits(r.phone).includes(qd)),
  )
}

export function columnValue(row: Participant, col: number): string {
  const c = COLUMNS[col]
  return c === 'number' ? String(row.number) : c === 'name' ? row.name : c === 'phone' ? row.phone : ''
}

export const isEditableCol = (col: number): boolean => EDITABLE.includes(COLUMNS[col] as Column)

export type Move = 'up' | 'down' | 'left' | 'right' | 'next' | 'prev' | 'home' | 'end'

/** Excel-like cursor movement clamped to the grid; Tab/Shift+Tab wrap to the next/previous row. */
export function moveCell(cell: Cell, move: Move, rowCount: number): Cell {
  if (rowCount <= 0) return { row: 0, col: cell.col }
  const last = rowCount - 1
  const cols = COLUMNS.length
  const clampRow = (r: number) => Math.min(last, Math.max(0, r))
  switch (move) {
    case 'up':
      return { row: clampRow(cell.row - 1), col: cell.col }
    case 'down':
      return { row: clampRow(cell.row + 1), col: cell.col }
    case 'left':
      return { row: cell.row, col: Math.max(0, cell.col - 1) }
    case 'right':
      return { row: cell.row, col: Math.min(cols - 1, cell.col + 1) }
    case 'next':
      if (cell.col < cols - 1) return { row: cell.row, col: cell.col + 1 }
      return cell.row < last ? { row: cell.row + 1, col: 0 } : cell
    case 'prev':
      if (cell.col > 0) return { row: cell.row, col: cell.col - 1 }
      return cell.row > 0 ? { row: cell.row - 1, col: cols - 1 } : cell
    case 'home':
      return { row: cell.row, col: 0 }
    case 'end':
      return { row: cell.row, col: cols - 1 }
  }
}

export interface SelectionState {
  selected: ReadonlySet<string>
  /** Row index (in the visible list) where a Shift-range starts. */
  anchor: number | null
}

/**
 * Click selection: a plain click selects only that row, Cmd/Ctrl toggles it, Shift selects the range
 * from the anchor. `ids` is the visible (filtered) order.
 */
export function applyClick(
  state: SelectionState,
  ids: readonly string[],
  index: number,
  mods: { shift: boolean; toggle: boolean },
): SelectionState {
  const id = ids[index]
  if (id === undefined) return state
  if (mods.shift && state.anchor !== null) {
    const [a, b] = state.anchor < index ? [state.anchor, index] : [index, state.anchor]
    const next = new Set(mods.toggle ? state.selected : [])
    for (let i = a; i <= b; i++) {
      const rid = ids[i]
      if (rid !== undefined) next.add(rid)
    }
    return { selected: next, anchor: state.anchor }
  }
  if (mods.toggle) {
    const next = new Set(state.selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return { selected: next, anchor: index }
  }
  return { selected: new Set([id]), anchor: index }
}

export function selectAllVisible(ids: readonly string[]): SelectionState {
  return { selected: new Set(ids), anchor: ids.length ? 0 : null }
}

export const allVisibleSelected = (ids: readonly string[], selected: ReadonlySet<string>): boolean =>
  ids.length > 0 && ids.every((id) => selected.has(id))

/** Drops selected ids that no longer exist so the selection never points at deleted rows. */
export function pruneSelection(selected: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  if (selected.size === 0) return selected
  const live = new Set(ids)
  let dropped = false
  const next = new Set<string>()
  for (const id of selected) {
    if (live.has(id)) next.add(id)
    else dropped = true
  }
  return dropped ? next : selected
}

/** True when the pasted text looks like spreadsheet data (several cells or several rows). */
export function isTabular(text: string): boolean {
  return /[\t\n]/.test(text.replace(/[\r\n]+$/, ''))
}

function unquote(cell: string): string {
  const c = cell.trim()
  return c.length >= 2 && c.startsWith('"') && c.endsWith('"') ? c.slice(1, -1).replace(/""/g, '"') : c
}

/**
 * Parses tab-separated clipboard text from Excel/Sheets into rows. Columns are name and phone; a
 * leading all-digit column (a copied "No." column) is dropped. Blank lines are skipped.
 */
export function parsePaste(text: string): ParticipantInput[] {
  const out: ParticipantInput[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let cells = line.split('\t').map(unquote)
    if (cells.length >= 3 && /^\d+$/.test(cells[0] ?? '')) cells = cells.slice(1)
    out.push({ name: cells[0] ?? '', phone: cells[1] ?? '' })
  }
  return out
}

export function clampCount(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null
  const n = Number(raw)
  return n >= 1 && n <= MAX_ADD_ROWS ? n : null
}
