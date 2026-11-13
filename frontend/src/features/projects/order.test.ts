import { describe, expect, it } from 'vitest'
import type { ProjectCardData } from './api'
import { projectActions } from './logic'
import { insertionIndex, moveProject, orderedIds } from './order'
import { asideWidth } from './ProjectCard'

const card = (id: string, status: 'active' | 'finished' = 'active'): ProjectCardData => ({
  id,
  title: id,
  status,
  image: null,
  online: [],
  participantCount: 0,
})
const ids = (l: ProjectCardData[]) => l.map((p) => p.id)

describe('moveProject', () => {
  const s = { active: [card('a'), card('b'), card('c')], finished: [card('x', 'finished')] }

  it('reorders inside a section (index counts the list without the moved card)', () => {
    const next = moveProject(s, 'a', 'active', 2)
    expect(next && ids(next.active)).toEqual(['b', 'c', 'a'])
    expect(next && orderedIds(next)).toEqual(['b', 'c', 'a', 'x'])
  })

  it('returns null when the card lands where it was', () => {
    expect(moveProject(s, 'b', 'active', 1)).toBeNull()
    expect(moveProject(s, 'nope', 'active', 0)).toBeNull()
  })

  it('moves to the other section and flips the status', () => {
    const next = moveProject(s, 'b', 'finished', 0)
    expect(next && ids(next.active)).toEqual(['a', 'c'])
    expect(next && ids(next.finished)).toEqual(['b', 'x'])
    expect(next?.finished[0]?.status).toBe('finished')
  })

  it('clamps an out-of-range index and does not mutate the input', () => {
    const next = moveProject(s, 'x', 'active', 99)
    expect(next && ids(next.active)).toEqual(['a', 'b', 'c', 'x'])
    expect(next?.active[3]?.status).toBe('active')
    expect(ids(s.active)).toEqual(['a', 'b', 'c'])
  })
})

describe('insertionIndex', () => {
  const r = (left: number, top: number) => ({ left, top, width: 100, height: 100 })
  const row = [r(0, 0), r(116, 0), r(232, 0)]

  it('is 0 for an empty section', () => {
    expect(insertionIndex([], { x: 5, y: 5 })).toBe(0)
  })

  it('goes before the card under the left half and after the one under the right half', () => {
    expect(insertionIndex(row, { x: 130, y: 50 })).toBe(1)
    expect(insertionIndex(row, { x: 205, y: 50 })).toBe(2)
  })

  it('uses the nearest card when the pointer is outside every card', () => {
    expect(insertionIndex(row, { x: 500, y: 400 })).toBe(3)
    expect(insertionIndex(row, { x: -40, y: 20 })).toBe(0)
  })
})

describe('projectActions with a position', () => {
  const can = (p: string) => ['project.update', 'project.finish'].includes(p)

  it('offers move up and down only where they make sense', () => {
    expect(projectActions(can, 'active', { index: 0, count: 3 })).toEqual(['settings', 'moveDown', 'finish'])
    expect(projectActions(can, 'active', { index: 1, count: 3 })).toEqual([
      'settings',
      'moveUp',
      'moveDown',
      'finish',
    ])
    expect(projectActions(can, 'finished', { index: 2, count: 3 })).toEqual(['moveUp', 'reopen'])
  })

  it('offers no move entries without project.update or without a position', () => {
    expect(projectActions((p) => p === 'project.finish', 'active', { index: 1, count: 3 })).toEqual([
      'finish',
    ])
    expect(projectActions(can, 'active')).toEqual(['settings', 'finish'])
  })
})

describe('asideWidth', () => {
  it('is 0 without avatars and menu, and grows with the shown avatars (capped, plus a +N chip)', () => {
    expect(asideWidth(0, false)).toBe(0)
    expect(asideWidth(0, true)).toBe(32)
    expect(asideWidth(1, true)).toBe(32 + 8 + 20 + 6)
    expect(asideWidth(3, false)).toBe(20 * 3 + 6)
    expect(asideWidth(9, false)).toBe(20 * 4 + 6)
  })
})
