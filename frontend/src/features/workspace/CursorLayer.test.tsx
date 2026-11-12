import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CursorLayer, MAX_SEGMENTS, placeCursors } from './CursorLayer'

const peer = (i: number) => ({
  id: `u${String(i).padStart(2, '0')}`,
  displayName: `User ${i}`,
  color: '#3ddc97',
})
const slotOf = (id: string) =>
  id === 'r1' ? { start: 0, size: 44 } : id === 'r2' ? { start: 44, size: 44 } : null
const inset = { top: 4, bottom: 4 }

describe('placeCursors', () => {
  it('gives a lone colleague the whole strip of the row', () => {
    const [c] = placeCursors(new Map([['r2', [peer(1)]]]), slotOf, inset)
    expect(c).toMatchObject({ y: 48, h: 36 })
  })

  it('skips rows that are not in the list', () => {
    expect(placeCursors(new Map([['gone', [peer(1)]]]), slotOf, inset)).toEqual([])
  })

  it('keeps ten colleagues inside the row: at most eight segments, none past the bottom edge', () => {
    const many = Array.from({ length: 10 }, (_, i) => peer(i + 1))
    const placed = placeCursors(new Map([['r1', many]]), slotOf, inset)
    expect(placed).toHaveLength(MAX_SEGMENTS)
    for (const c of placed) {
      expect(c.y).toBeGreaterThanOrEqual(4)
      expect(c.y + c.h).toBeLessThanOrEqual(40.001)
    }
  })

  it('orders people by id so a segment keeps its place when someone else moves', () => {
    const a = placeCursors(new Map([['r1', [peer(2), peer(1)]]]), slotOf, inset)
    const b = placeCursors(new Map([['r1', [peer(1), peer(2)]]]), slotOf, inset)
    expect(a).toEqual(b)
  })
})

describe('placeCursors order', () => {
  it('lists people in id order whatever rows they are on, so their elements are never reordered in the DOM', () => {
    const rows = (first: string, second: string) =>
      new Map([
        [first, [peer(2)]],
        [second, [peer(1)]],
      ])
    const ids = (m: Map<string, ReturnType<typeof peer>[]>) => placeCursors(m, slotOf, inset).map((c) => c.id)
    expect(ids(rows('r1', 'r2'))).toEqual(ids(rows('r2', 'r1')))
  })
})

describe('CursorLayer', () => {
  it('renders nothing without cursors', () => {
    const { container } = render(<CursorLayer items={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('draws one segment per person, positioned with transform only', () => {
    const { container } = render(<CursorLayer items={[{ id: 'u1', color: '#fff', y: 48, h: 36 }]} />)
    const seg = container.querySelector<HTMLElement>('.pt-cursor')
    expect(seg?.style.transform).toBe('translateY(48px) scaleY(36)')
  })
})
