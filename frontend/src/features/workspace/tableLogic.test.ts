import { describe, expect, it } from 'vitest'
import type { Participant } from './api'
import {
  allVisibleSelected,
  applyClick,
  clampCount,
  filterRows,
  isTabular,
  moveCell,
  parsePaste,
  pruneSelection,
  selectAllVisible,
} from './tableLogic'

const row = (n: number, name: string, phone: string): Participant => ({
  id: `id${n}`,
  projectId: 'p',
  number: n,
  name,
  phone,
  version: 1,
  updatedAt: '2026-11-07T10:00:00Z',
})
const ROWS = [
  row(1, 'Timur Rahimov', '+7 912 305-14-22'),
  row(2, 'Nadezhda Sokolova', '+7 903 771-08-56'),
  row(3, 'Otabek Karimov', '+998 90 123-45-67'),
]
const ids = ROWS.map((r) => r.id)

describe('filterRows', () => {
  it('matches names case-insensitively and phones by substring', () => {
    expect(filterRows(ROWS, 'timur').map((r) => r.number)).toEqual([1])
    expect(filterRows(ROWS, '771').map((r) => r.number)).toEqual([2])
    expect(filterRows(ROWS, '  ')).toBe(ROWS)
  })

  it('matches a digits-only query against formatted phones', () => {
    expect(filterRows(ROWS, '99890123').map((r) => r.number)).toEqual([3])
    expect(filterRows(ROWS, '7912305').map((r) => r.number)).toEqual([1])
  })

  it('returns nothing for an unknown query', () => {
    expect(filterRows(ROWS, 'zzz')).toEqual([])
  })
})

describe('moveCell (Excel-like movement)', () => {
  it('clamps arrows to the grid', () => {
    expect(moveCell({ row: 0, col: 0 }, 'up', 3)).toEqual({ row: 0, col: 0 })
    expect(moveCell({ row: 2, col: 2 }, 'down', 3)).toEqual({ row: 2, col: 2 })
    expect(moveCell({ row: 1, col: 0 }, 'left', 3)).toEqual({ row: 1, col: 0 })
    expect(moveCell({ row: 1, col: 2 }, 'right', 3)).toEqual({ row: 1, col: 2 })
  })

  it('wraps Tab to the next and previous row', () => {
    expect(moveCell({ row: 0, col: 2 }, 'next', 3)).toEqual({ row: 1, col: 0 })
    expect(moveCell({ row: 1, col: 0 }, 'prev', 3)).toEqual({ row: 0, col: 2 })
  })

  it('stays put on Tab at the very first/last cell so focus can leave the grid', () => {
    expect(moveCell({ row: 2, col: 2 }, 'next', 3)).toEqual({ row: 2, col: 2 })
    expect(moveCell({ row: 0, col: 0 }, 'prev', 3)).toEqual({ row: 0, col: 0 })
  })

  it('handles an empty list', () => {
    expect(moveCell({ row: 0, col: 1 }, 'down', 0)).toEqual({ row: 0, col: 1 })
  })
})

describe('selection', () => {
  const empty = { selected: new Set<string>(), anchor: null }

  it('selects a single row on plain click and moves the anchor', () => {
    const s = applyClick(empty, ids, 1, { shift: false, toggle: false })
    expect([...s.selected]).toEqual(['id2'])
    expect(s.anchor).toBe(1)
  })

  it('toggles with Cmd/Ctrl', () => {
    let s = applyClick(empty, ids, 0, { shift: false, toggle: true })
    s = applyClick(s, ids, 2, { shift: false, toggle: true })
    expect([...s.selected].sort()).toEqual(['id1', 'id3'])
    s = applyClick(s, ids, 0, { shift: false, toggle: true })
    expect([...s.selected]).toEqual(['id3'])
  })

  it('selects a range with Shift from the anchor, in either direction', () => {
    const start = applyClick(empty, ids, 2, { shift: false, toggle: false })
    const s = applyClick(start, ids, 0, { shift: true, toggle: false })
    expect([...s.selected].sort()).toEqual(['id1', 'id2', 'id3'])
    expect(s.anchor).toBe(2)
  })

  it('keeps the old selection for Shift+Cmd range clicks', () => {
    let s = applyClick(empty, ids, 0, { shift: false, toggle: false })
    s = applyClick(s, ids, 2, { shift: true, toggle: true })
    expect(s.selected.size).toBe(3)
  })

  it('selects all visible rows and reports it', () => {
    const all = selectAllVisible(ids)
    expect(allVisibleSelected(ids, all.selected)).toBe(true)
    expect(allVisibleSelected(ids, new Set(['id1']))).toBe(false)
    expect(allVisibleSelected([], new Set())).toBe(false)
  })

  it('prunes ids that no longer exist and keeps identity when nothing changed', () => {
    const sel = new Set(['id1', 'gone'])
    expect([...pruneSelection(sel, ids)]).toEqual(['id1'])
    const same = new Set(['id1'])
    expect(pruneSelection(same, ids)).toBe(same)
  })
})

describe('paste parsing', () => {
  it('splits tab-separated rows into name and phone', () => {
    expect(parsePaste('Ann\t+1 111\r\nBob\t+2 222\r\n')).toEqual([
      { name: 'Ann', phone: '+1 111' },
      { name: 'Bob', phone: '+2 222' },
    ])
  })

  it('drops a leading numeric "No." column copied from a spreadsheet', () => {
    expect(parsePaste('1\tAnn\t+1 111\n2\tBob\t+2 222')).toEqual([
      { name: 'Ann', phone: '+1 111' },
      { name: 'Bob', phone: '+2 222' },
    ])
  })

  it('keeps a name that merely contains digits, skips blank lines, strips quotes', () => {
    expect(parsePaste('"Ann ""A"" Lee"\t+1\n\n  \nBob')).toEqual([
      { name: 'Ann "A" Lee', phone: '+1' },
      { name: 'Bob', phone: '' },
    ])
  })

  it('treats a single value as non-tabular and several cells or rows as tabular', () => {
    expect(isTabular('just text')).toBe(false)
    expect(isTabular('one line\n')).toBe(false)
    expect(isTabular('a\tb')).toBe(true)
    expect(isTabular('a\nb')).toBe(true)
  })
})

describe('clampCount', () => {
  it('accepts 1..5000 only', () => {
    expect(clampCount('1')).toBe(1)
    expect(clampCount(' 5000 ')).toBe(5000)
    expect(clampCount('0')).toBeNull()
    expect(clampCount('5001')).toBeNull()
    expect(clampCount('-3')).toBeNull()
    expect(clampCount('1.5')).toBeNull()
    expect(clampCount('')).toBeNull()
  })
})
