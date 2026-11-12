import { describe, expect, it } from 'vitest'
import { buildRowPresence } from './presence'

const peers = [
  { id: 'u1', displayName: 'Aziza', color: '#111111', avatarUrl: null },
  { id: 'u2', displayName: 'Bobur', color: '#222222', avatarUrl: null },
]

describe('buildRowPresence cursors', () => {
  it('shows one cursor per row: the colleague who pointed at it last', () => {
    // The snapshot re-adds a colleague's cursor after each move, so later entries are more recent.
    const p = buildRowPresence('me', peers, {}, { u1: { rowId: 'r1' }, u2: { rowId: 'r1' } }, 'Someone')
    expect(p.cursors.get('r1')?.id).toBe('u2')
    expect(p.cursors.size).toBe(1)
  })

  it('brings the earlier colleague back when the later one moves on', () => {
    const p = buildRowPresence('me', peers, {}, { u1: { rowId: 'r1' }, u2: { rowId: 'r2' } }, 'Someone')
    expect(p.cursors.get('r1')?.id).toBe('u1')
    expect(p.cursors.get('r2')?.id).toBe('u2')
  })

  it('never shows your own cursor', () => {
    const p = buildRowPresence('u1', peers, {}, { u1: { rowId: 'r1' } }, 'Someone')
    expect(p.cursors.size).toBe(0)
  })
})
