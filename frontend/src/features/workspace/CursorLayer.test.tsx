import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CursorLayer, placeCursors } from './CursorLayer'

const peer = (i: number) => ({
  id: `u${String(i).padStart(2, '0')}`,
  displayName: `User ${i}`,
  color: '#3ddc97',
})
const slotOf = (id: string) =>
  id === 'r1' ? { start: 0, size: 44 } : id === 'r2' ? { start: 44, size: 44 } : null
const inset = { top: 8, bottom: 8 }

describe('placeCursors', () => {
  it('draws the colleague as tall as the current-row marker: the row minus 8px at each end', () => {
    const [c] = placeCursors(new Map([['r2', peer(1)]]), slotOf, inset)
    expect(c).toMatchObject({ y: 52, h: 28 })
  })

  it('skips rows that are not in the list', () => {
    expect(placeCursors(new Map([['gone', peer(1)]]), slotOf, inset)).toEqual([])
  })

  it('lists people in id order whatever rows they are on, so their elements are never reordered in the DOM', () => {
    const ids = (m: Map<string, ReturnType<typeof peer>>) => placeCursors(m, slotOf, inset).map((c) => c.id)
    const a = new Map([
      ['r1', peer(2)],
      ['r2', peer(1)],
    ])
    const b = new Map([
      ['r2', peer(1)],
      ['r1', peer(2)],
    ])
    expect(ids(a)).toEqual(ids(b))
  })
})

describe('CursorLayer', () => {
  it('renders nothing without cursors', () => {
    const { container } = render(<CursorLayer items={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('draws one bar per person, positioned with transform', () => {
    const { container } = render(<CursorLayer items={[{ id: 'u1', color: '#fff', y: 52, h: 28 }]} />)
    const seg = container.querySelector<HTMLElement>('.pt-cursor')
    expect(seg?.style.transform).toBe('translateY(52px)')
    expect(seg?.style.height).toBe('28px')
  })
})
