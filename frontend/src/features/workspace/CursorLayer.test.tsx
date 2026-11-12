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
const inset = { top: 4, bottom: 4 }

describe('placeCursors', () => {
  it('gives the colleague the whole strip of their row', () => {
    const [c] = placeCursors(new Map([['r2', peer(1)]]), slotOf, inset)
    expect(c).toMatchObject({ y: 48, h: 36 })
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

  it('draws one strip per person, positioned with transform only', () => {
    const { container } = render(<CursorLayer items={[{ id: 'u1', color: '#fff', y: 48, h: 36 }]} />)
    const seg = container.querySelector<HTMLElement>('.pt-cursor')
    expect(seg?.style.transform).toBe('translateY(48px) scaleY(36)')
  })
})
