import { describe, expect, it } from 'vitest'
import { mergeRows, type Participant } from './api'

const row = (n: number, version = 1, name = `P${n}`): Participant =>
  ({ id: `id${n}`, number: n, name, phone: '', version }) as Participant

describe('mergeRows', () => {
  it('does not duplicate rows that a realtime push already inserted', () => {
    const cached = [row(1), row(2), row(3)]
    expect(mergeRows(cached, [row(2), row(3)]).map((r) => r.number)).toEqual([1, 2, 3])
  })

  it('adds unknown rows in number order and keeps the newer version', () => {
    const merged = mergeRows([row(1, 3, 'new'), row(4)], [row(1, 2, 'old'), row(2), row(3)])
    expect(merged.map((r) => r.number)).toEqual([1, 2, 3, 4])
    expect(merged[0]?.name).toBe('new')
  })
})
