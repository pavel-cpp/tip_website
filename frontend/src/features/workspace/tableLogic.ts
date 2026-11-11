import type { Participant, ParticipantInput } from './api'

/** Grid columns in display order. Only `name` and `phone` are editable; `number` is assigned by the server. */
export const COLUMNS = ['number', 'name', 'phone'] as const
export type Column = (typeof COLUMNS)[number]
export const EDITABLE: readonly Column[] = ['name', 'phone']
export const MAX_ADD_ROWS = 5000

/**
 * Phone cards: the first tap on a card only selects it (the ticket follows), a second tap on the card that is
 * already selected opens the editor. `armed` is the card the last pick selected.
 */
export const tapAction = (armed: string | null, id: string): 'select' | 'open' =>
  armed === id ? 'open' : 'select'

export interface Cell {
  row: number
  col: number
}

const digits = (s: string) => s.replace(/\D/g, '')

/**
 * Case-insensitive substring match on name and phone; digits-only queries also match formatted phones.
 * A numeric query ("12", "#12", "№12") additionally finds the row with exactly that number.
 */
export function filterRows(rows: readonly Participant[], query: string): readonly Participant[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  const qd = digits(q)
  const phoneByDigits = qd.length > 0 && qd === q.replace(/[\s()+-]/g, '')
  const asNumber = /^[#№]?\s*(\d{1,9})$/.exec(q)
  const number = asNumber ? Number(asNumber[1]) : -1
  return rows.filter(
    (r) =>
      r.number === number ||
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

/** Row ids from index `from` to `to` (either order) in the visible list, added to `base`. */
export function rangeSelection(
  ids: readonly string[],
  from: number,
  to: number,
  base: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const [a, b] = from < to ? [from, to] : [to, from]
  const next = new Set(base)
  for (let i = Math.max(0, a); i <= Math.min(ids.length - 1, b); i++) next.add(ids[i] as string)
  return next
}

/** Index of the row under a pointer at `clientY`, clamped to the list; rows have a fixed height. */
export function rowIndexAt(
  clientY: number,
  viewportTop: number,
  scrollTop: number,
  rowHeight: number,
  count: number,
): number {
  if (count <= 0) return -1
  const i = Math.floor((clientY - viewportTop + scrollTop) / rowHeight)
  return Math.min(count - 1, Math.max(0, i))
}

/**
 * Pixels to scroll per frame while a drag is near (or beyond) the top or bottom edge of the list:
 * negative scrolls up, 0 in the middle, growing with the distance past the edge zone up to `max`.
 */
export function autoScrollStep(clientY: number, top: number, bottom: number, edge = 48, max = 28): number {
  if (clientY < top + edge) return -Math.min(max, Math.max(4, Math.round((top + edge - clientY) / 3)))
  if (clientY > bottom - edge) return Math.min(max, Math.max(4, Math.round((clientY - (bottom - edge)) / 3)))
  return 0
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

export function clampCount(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null
  const n = Number(raw)
  return n >= 1 && n <= MAX_ADD_ROWS ? n : null
}

/** File-system safe fragment: letters, digits, `_` and `-` only, capped in length. */
export function safeFilePart(s: string, max = 40): string {
  return s
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/g, '')
}

export type PasteField = 'name' | 'phone'
const FIELD_LIMIT: Record<PasteField, number> = { name: 200, phone: 40 }

/** Pasted text as rows of cells plus the fields they fill. */
export interface PasteGrid {
  fields: PasteField[]
  lines: string[][]
}

function unquote(cell: string): string {
  const c = cell.trim()
  return c.length >= 2 && c.startsWith('"') && c.endsWith('"') ? c.slice(1, -1).replace(/""/g, '"') : c
}

/**
 * Parses clipboard text (tab-separated cells from Excel/Sheets, or plain lines). One column fills the
 * column the cursor is in; two or more fill name and phone. A leading all-digit column (a copied
 * "No." column) is dropped. Empty lines are kept (they are empty cells); one trailing newline is not a line.
 */
export function parsePasteGrid(text: string, col: number): PasteGrid {
  const raw = text.replace(/\r\n?/g, '\n')
  const lines = (raw.endsWith('\n') ? raw.slice(0, -1) : raw)
    .split('\n')
    .map((l) => l.split('\t').map(unquote))
  let width = lines.reduce((w, l) => Math.max(w, l.length), 1)
  if (width >= 3 && lines.every((l) => l[0] === undefined || l[0] === '' || /^\d+$/.test(l[0]))) {
    for (const l of lines) l.shift()
    width--
  }
  const one: PasteField = COLUMNS[col] === 'phone' ? 'phone' : 'name'
  return { fields: width === 1 ? [one] : ['name', 'phone'], lines }
}

/** True when a paste is more than one plain value: several lines or cells. */
export const isMultiCell = (text: string): boolean => /[\t\n]/.test(text.replace(/[\r\n]+$/, ''))

export interface PasteUpdate {
  row: Participant
  name?: string
  phone?: string
}

export interface PastePlan {
  /** Existing rows to overwrite; cells that already hold the value are left out. */
  updates: PasteUpdate[]
  /** Lines that fall below the last row; they become new rows. */
  creates: ParticipantInput[]
  /** Lines (or selected rows, for a single value) written. */
  applied: number
  /** Row the paste starts at, for the "starting from" message. */
  first: Participant | null
}

/**
 * Plans a paste over the visible rows. Lines fill the selected rows top to bottom (or start at the
 * cursor row when at most one row is selected) and continue below the last targeted row; lines past
 * the end of the table become new rows. Fewer lines than selected rows fill the first rows only, and a
 * single line pasted onto several selected rows fills all of them.
 */
export function planPaste(
  visible: readonly Participant[],
  selected: ReadonlySet<string>,
  activeRow: number | null,
  col: number,
  text: string,
): PastePlan {
  const grid = parsePasteGrid(text, col)
  const picked: number[] = []
  visible.forEach((r, i) => {
    if (selected.has(r.id)) picked.push(i)
  })
  const targets = picked.length > 1 ? picked : [activeRow ?? picked[0] ?? 0]
  const last = targets[targets.length - 1] as number
  const everyone = grid.lines.length === 1 && targets.length > 1
  const count = everyone ? targets.length : grid.lines.length

  const plan: PastePlan = {
    updates: [],
    creates: [],
    applied: count,
    first: visible[targets[0] as number] ?? null,
  }
  for (let i = 0; i < count; i++) {
    const cells = grid.lines[everyone ? 0 : i] as string[]
    const index = i < targets.length ? (targets[i] as number) : last + (i - targets.length + 1)
    const values: Partial<Record<PasteField, string>> = {}
    grid.fields.forEach((f, k) => {
      values[f] = (cells[k] ?? '').trim().slice(0, FIELD_LIMIT[f])
    })
    const row = visible[index]
    if (!row) {
      plan.creates.push({ name: values.name ?? '', phone: values.phone ?? '' })
      continue
    }
    const update: PasteUpdate = { row }
    if (values.name !== undefined && values.name !== row.name) update.name = values.name
    if (values.phone !== undefined && values.phone !== row.phone) update.phone = values.phone
    if (update.name !== undefined || update.phone !== undefined) plan.updates.push(update)
  }
  return plan
}
