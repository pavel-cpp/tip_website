import { describe, expect, it } from 'vitest'
import type { Participant } from './api'
import {
  allVisibleSelected,
  applyClick,
  autoScrollStep,
  clampCount,
  filterRows,
  isMultiCell,
  moveCell,
  parsePasteGrid,
  planPaste,
  pruneSelection,
  rangeSelection,
  rowIndexAt,
  safeFilePart,
  selectAllVisible,
  tapAction,
} from './tableLogic'

describe('tapAction', () => {
  it('selects on the first tap and opens on a tap of the already selected card', () => {
    expect(tapAction(null, 'a')).toBe('select')
    expect(tapAction('b', 'a')).toBe('select')
    expect(tapAction('a', 'a')).toBe('open')
  })
})

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

  it('finds a row by its number, with or without # or №, but not by a longer number', () => {
    const plain = [row(1, 'A', ''), row(2, 'B', ''), row(12, 'C', ''), row(120, 'D', ''), row(21, 'E', '')]
    expect(filterRows(plain, '12').map((r) => r.number)).toEqual([12])
    expect(filterRows(plain, '#2').map((r) => r.number)).toEqual([2])
    expect(filterRows(plain, '№ 1').map((r) => r.number)).toEqual([1])
    // a number and a text match both count: row 3 carries "2" in its phone
    expect(filterRows([...plain, row(3, 'F', '+2')], '2').map((r) => r.number)).toEqual([2, 3])
  })

  it('stays instant on 5000 rows', () => {
    const many = Array.from({ length: 5000 }, (_, i) => row(i + 1, `Name ${i}`, `+998 90 ${i}`))
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) filterRows(many, '1234')
    expect((performance.now() - t0) / 20).toBeLessThan(15)
    expect(filterRows(many, '4999').map((r) => r.number)).toContain(4999)
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

describe('mouse selection helpers', () => {
  const ids5 = ['a', 'b', 'c', 'd', 'e']
  it('selects a block in either direction and adds it to a base selection', () => {
    expect([...rangeSelection(ids5, 1, 3)]).toEqual(['b', 'c', 'd'])
    expect([...rangeSelection(ids5, 3, 1)]).toEqual(['b', 'c', 'd'])
    expect([...rangeSelection(ids5, 0, 0, new Set(['e']))].sort()).toEqual(['a', 'e'])
    expect([...rangeSelection(ids5, -4, 99)]).toEqual(ids5)
  })
  it('maps a pointer position to a row from the scroll offset, clamped to the list', () => {
    expect(rowIndexAt(100, 40, 0, 44, 10)).toBe(1)
    expect(rowIndexAt(100, 40, 4400, 44, 5000)).toBe(101)
    expect(rowIndexAt(-50, 40, 0, 44, 10)).toBe(0)
    expect(rowIndexAt(9999, 40, 0, 44, 10)).toBe(9)
    expect(rowIndexAt(10, 0, 0, 44, 0)).toBe(-1)
  })
  it('scrolls only near the edges and faster the further the pointer is outside', () => {
    expect(autoScrollStep(300, 100, 500)).toBe(0)
    expect(autoScrollStep(90, 100, 500)).toBeLessThan(0)
    expect(autoScrollStep(520, 100, 500)).toBeGreaterThan(0)
    expect(autoScrollStep(900, 100, 500)).toBeGreaterThan(autoScrollStep(520, 100, 500))
    expect(autoScrollStep(100000, 100, 500)).toBe(28)
  })
})

describe('paste parsing', () => {
  it('reads one column into the cursor column and two or more into name and phone', () => {
    expect(parsePasteGrid('A\nB\n', 1)).toEqual({ fields: ['name'], lines: [['A'], ['B']] })
    expect(parsePasteGrid('1\n2', 2).fields).toEqual(['phone'])
    expect(parsePasteGrid('A\t+1\r\nB\t+2\r\n', 1)).toEqual({
      fields: ['name', 'phone'],
      lines: [
        ['A', '+1'],
        ['B', '+2'],
      ],
    })
  })
  it('drops a leading numeric "No." column of a three-column copy', () => {
    expect(parsePasteGrid('4\tAnn\t+1\n5\tBob\t+2', 1).lines).toEqual([
      ['Ann', '+1'],
      ['Bob', '+2'],
    ])
    expect(parsePasteGrid('Ann\t+1\textra', 1).fields).toEqual(['name', 'phone'])
  })
  it('keeps empty lines as empty cells and strips spreadsheet quotes', () => {
    expect(parsePasteGrid('A\n\nB', 1).lines).toEqual([['A'], [''], ['B']])
    expect(parsePasteGrid('"Say ""hi"""', 1).lines).toEqual([['Say "hi"']])
  })
  it('treats a single value as plain and several cells or rows as multi-cell', () => {
    expect(isMultiCell('Timur')).toBe(false)
    expect(isMultiCell('Timur\n')).toBe(false)
    expect(isMultiCell('Timur\t+7')).toBe(true)
    expect(isMultiCell('a\nb')).toBe(true)
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

describe('planPaste', () => {
  const table = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1, `n${i + 1}`, `p${i + 1}`))
  const rows = table(6)
  const pick = (...n: number[]) => new Set(n.map((x) => `id${x}`))
  const names = (plan: ReturnType<typeof planPaste>) =>
    plan.updates.map((u) => [u.row.number, u.name, u.phone])

  it('fills the selected cells top to bottom, fewer lines fill the first cells', () => {
    const plan = planPaste(rows, pick(2, 3, 4), 1, 1, 'A\nB')
    expect(names(plan)).toEqual([
      [2, 'A', undefined],
      [3, 'B', undefined],
    ])
    expect(plan.creates).toEqual([])
    expect(plan.applied).toBe(2)
    expect(plan.first?.number).toBe(2)
  })

  it('continues below the selection when there are more lines than cells', () => {
    const plan = planPaste(rows, pick(2, 3), 1, 1, 'A\nB\nC\nD')
    expect(names(plan).map((x) => x[0])).toEqual([2, 3, 4, 5])
  })

  it('starts at the cursor row when one row is selected, and creates rows only past the end', () => {
    const plan = planPaste(rows, pick(5), 4, 1, 'A\nB\nC\nD')
    expect(names(plan).map((x) => x[0])).toEqual([5, 6])
    expect(plan.creates).toEqual([
      { name: 'C', phone: '' },
      { name: 'D', phone: '' },
    ])
    expect(plan.applied).toBe(4)
  })

  it('writes name and phone for two-column data and only the cursor column for one column', () => {
    expect(names(planPaste(rows, pick(1), 0, 1, 'X\t+9\nY\t+8'))).toEqual([
      [1, 'X', '+9'],
      [2, 'Y', '+8'],
    ])
    expect(names(planPaste(rows, pick(1), 0, 2, 'P1\nP2'))).toEqual([
      [1, undefined, 'P1'],
      [2, undefined, 'P2'],
    ])
    expect(planPaste(rows, pick(6), 5, 2, 'P\nQ').creates).toEqual([{ name: '', phone: 'Q' }])
  })

  it('fills every selected row with a single pasted value', () => {
    const plan = planPaste(rows, pick(1, 3, 5), 0, 1, 'Same')
    expect(names(plan)).toEqual([
      [1, 'Same', undefined],
      [3, 'Same', undefined],
      [5, 'Same', undefined],
    ])
    expect(plan.applied).toBe(3)
  })

  it('leaves out cells that already hold the value and clamps to the field limits', () => {
    const plan = planPaste(rows, pick(1), 0, 1, `n1\n${'x'.repeat(300)}`)
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0]?.name).toHaveLength(200)
    expect(plan.applied).toBe(2)
  })

  it('plans 5000 lines over 5000 rows quickly', () => {
    const big = table(5000)
    const text = Array.from({ length: 5000 }, (_, i) => `N${i}\t+${i}`).join('\n')
    const t0 = performance.now()
    const plan = planPaste(big, new Set(), 0, 1, text)
    expect(performance.now() - t0).toBeLessThan(200)
    expect(plan.updates).toHaveLength(5000)
    expect(plan.creates).toHaveLength(0)
  })
})

describe('safeFilePart', () => {
  it('keeps letters and digits, replaces the rest and trims', () => {
    expect(safeFilePart('Tashkent City: Mall / 2026!')).toBe('Tashkent_City_Mall_2026')
    expect(safeFilePart('  ../..  ')).toBe('')
    expect(safeFilePart('Узбек Имя')).toBe('Узбек_Имя')
    expect(safeFilePart('a'.repeat(100), 10)).toBe('aaaaaaaaaa')
  })
})
