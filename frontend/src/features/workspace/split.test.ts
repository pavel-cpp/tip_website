import { describe, expect, it } from 'vitest'
import { stepRow } from './rowStep'
import {
  applyArrow,
  arrowAction,
  clampRatio,
  DEFAULT_SPLIT,
  MAX_RATIO,
  MIN_RATIO,
  nudgeRatio,
  parseSplit,
  ratioFromPointer,
  tracks,
} from './split'

describe('splitter math', () => {
  it('clamps the ratio and repairs garbage', () => {
    expect(clampRatio(0)).toBe(MIN_RATIO)
    expect(clampRatio(1)).toBe(MAX_RATIO)
    expect(clampRatio(Number.NaN)).toBe(0.5)
  })

  it('maps the pointer to a ratio without the handle width', () => {
    // 1000 px container, 20 px handle: the centre of the handle at 500 is the exact middle.
    expect(ratioFromPointer(500, 0, 1000, 20)).toBeCloseTo(0.5)
    expect(ratioFromPointer(-50, 0, 1000, 20)).toBe(MIN_RATIO)
    expect(ratioFromPointer(5000, 0, 1000, 20)).toBe(MAX_RATIO)
    expect(ratioFromPointer(10, 0, 10, 20)).toBe(0.5)
  })

  it('nudges by a small or a big step and stays inside the limits', () => {
    expect(nudgeRatio(0.5, 1)).toBeCloseTo(0.53)
    expect(nudgeRatio(0.5, -1, true)).toBeCloseTo(0.4)
    expect(nudgeRatio(MAX_RATIO, 1)).toBe(MAX_RATIO)
  })

  it('hides a panel with the arrow pointing at it and restores it with the opposite arrow', () => {
    expect(applyArrow(null, 'first')).toBe('first')
    expect(applyArrow(null, 'second')).toBe('second')
    expect(applyArrow('first', 'second')).toBeNull()
    expect(applyArrow('second', 'first')).toBeNull()
    // The arrow pointing at the already hidden panel does nothing.
    expect(arrowAction('first', 'first')).toBeNull()
    expect(applyArrow('first', 'first')).toBe('first')
  })

  it('builds the track list', () => {
    expect(tracks({ ratio: 0.4, collapsed: null }, 20)).toBe('0.4fr 20px 0.6fr')
    expect(tracks({ ratio: 0.4, collapsed: 'first' }, 20)).toBe('0fr 20px 1fr')
    expect(tracks({ ratio: 0.4, collapsed: 'second' }, 20)).toBe('1fr 20px 0fr')
  })

  it('parses stored state defensively', () => {
    expect(parseSplit(null)).toEqual(DEFAULT_SPLIT)
    expect(parseSplit('{nope')).toEqual(DEFAULT_SPLIT)
    expect(parseSplit('{"ratio":0.3,"collapsed":"second"}')).toEqual({ ratio: 0.3, collapsed: 'second' })
    expect(parseSplit('{"ratio":9,"collapsed":"x"}')).toEqual({ ratio: MAX_RATIO, collapsed: null })
  })
})

describe('stepRow', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  it('moves to the neighbours and stops at the ends', () => {
    expect(stepRow(rows, 'b', 1)?.id).toBe('c')
    expect(stepRow(rows, 'b', -1)?.id).toBe('a')
    expect(stepRow(rows, 'c', 1)).toBeNull()
    expect(stepRow(rows, 'a', -1)).toBeNull()
  })
  it('starts at an end when nothing is current', () => {
    expect(stepRow(rows, null, 1)?.id).toBe('a')
    expect(stepRow(rows, 'gone', -1)?.id).toBe('c')
    expect(stepRow([], null, 1)).toBeNull()
  })
})
