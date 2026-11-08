import { describe, expect, it } from 'vitest'
import {
  BIG_PRINT_THRESHOLD,
  estimateMs,
  formatDuration,
  PRINT_MS_PER_TICKET,
  remainingMs,
  roundedSeconds,
} from './printEstimate'

describe('print estimate', () => {
  it('scales with the batch size', () => {
    expect(estimateMs(0)).toBe(0)
    expect(estimateMs(5000)).toBe(5000 * PRINT_MS_PER_TICKET)
    expect(BIG_PRINT_THRESHOLD).toBe(500)
  })

  it('stays silent until there is enough data, then extrapolates the pace', () => {
    expect(remainingMs(3, 100, 300)).toBeNull()
    expect(remainingMs(100, 100, 5000)).toBeNull()
    // 10 tickets in 1 s -> 90 more take 9 s.
    expect(remainingMs(10, 100, 1000)).toBe(9000)
  })

  it('rounds up to a calm step', () => {
    expect(roundedSeconds(1)).toBe(5)
    expect(roundedSeconds(12_300)).toBe(15)
    expect(roundedSeconds(61_000)).toBe(70)
    expect(roundedSeconds(601_000)).toBe(630)
  })

  it('formats seconds, minutes and both', () => {
    const t = (key: string, p: Record<string, number> = {}) => `${key}:${p.m ?? ''}:${p.s ?? ''}`
    expect(formatDuration(20_000, t as never)).toBe('workspace.duration.sec::20')
    expect(formatDuration(180_000, t as never)).toBe('workspace.duration.min:3:')
    expect(formatDuration(200_000, t as never)).toBe('workspace.duration.minSec:3:20')
  })
})
