import { describe, expect, it } from 'vitest'
import { followJump, peerStatus, spotlightCss } from './follow'

const lock = (by: string) => ({ by, expiresAt: '2030-01-01T00:00:00Z' })

describe('peerStatus', () => {
  it('reports editing with the field when the peer holds a lock', () => {
    const s = peerStatus('u1', { u1: { rowId: 'r1', field: 'name' } }, { r1: lock('u1') })
    expect(s).toEqual({ rowId: 'r1', field: 'name', editing: true })
  })
  it('reports looking when there is only a cursor', () => {
    expect(peerStatus('u1', { u1: { rowId: 'r2', field: 'phone' } }, { r1: lock('u2') })).toEqual({
      rowId: 'r2',
      field: 'phone',
      editing: false,
    })
  })
  it('has no row when the peer has no cursor', () => {
    expect(peerStatus('u1', {}, {})).toEqual({ rowId: null, editing: false })
  })
  it('ignores the cursor field when it belongs to another row than the lock', () => {
    expect(peerStatus('u1', { u1: { rowId: 'r9', field: 'phone' } }, { r1: lock('u1') })).toEqual({
      rowId: 'r1',
      editing: true,
    })
  })
})

describe('followJump', () => {
  const has = (id: string) => id !== 'gone'
  it('jumps only when the peer moved to an existing row', () => {
    expect(followJump('r2', 'r1', has)).toBe('r2')
    expect(followJump('r1', 'r1', has)).toBeNull()
    expect(followJump('gone', 'r1', has)).toBeNull()
    expect(followJump(null, 'r1', has)).toBeNull()
  })
})

describe('spotlightCss', () => {
  it('builds a rule for a safe id and colour', () => {
    expect(spotlightCss('abc-123', '#ff0000')).toContain('[data-row-id="abc-123"]')
    expect(spotlightCss('abc-123', '#ff0000')).toContain('#ff0000')
  })
  it('refuses ids that could break out of the selector and falls back for odd colours', () => {
    expect(spotlightCss('a"]{x', '#fff')).toBe('')
    expect(spotlightCss(null, '#fff')).toBe('')
    expect(spotlightCss('a', 'red;}')).toContain('var(--accent)')
  })
})
