import { describe, expect, it } from 'vitest'
import { stepRow } from './rowStep'
import {
  COLLAPSE_AT,
  clampRatio,
  DEFAULT_SPLIT,
  dragState,
  handleRatio,
  hideSide,
  liveTracks,
  MAX_RATIO,
  MIN_RATIO,
  nudgeState,
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

  it('maps the pointer to an unclamped ratio without the handle width', () => {
    // 1000 px container, 20 px handle: the centre of the handle at 500 is the exact middle.
    expect(ratioFromPointer(500, 0, 1000, 20)).toBeCloseTo(0.5)
    expect(ratioFromPointer(-50, 0, 1000, 20)).toBeLessThan(0)
    expect(ratioFromPointer(10, 0, 10, 20)).toBe(0.5)
  })

  it('hides a panel when the handle is dragged to its edge and shows it when pulled back', () => {
    const open = { ratio: 0.4, collapsed: null } as const
    expect(dragState(0.6, open)).toEqual({ ratio: 0.6, collapsed: null })
    // Between the collapse point and the minimum the panel keeps its minimum size.
    expect(dragState(COLLAPSE_AT + 0.01, open)).toEqual({ ratio: MIN_RATIO, collapsed: null })
    const hidden = dragState(0.02, open)
    expect(hidden).toEqual({ ratio: 0.4, collapsed: 'first' })
    // Hysteresis: a small move back keeps it hidden, a real pull reopens it.
    expect(dragState(COLLAPSE_AT + 0.02, hidden).collapsed).toBe('first')
    expect(dragState(0.3, hidden)).toEqual({ ratio: 0.3, collapsed: null })
    expect(dragState(0.99, open)).toEqual({ ratio: 0.4, collapsed: 'second' })
    expect(dragState(0.7, { ratio: 0.4, collapsed: 'second' })).toEqual({ ratio: 0.7, collapsed: null })
    expect(dragState(Number.NaN, open)).toBe(open)
  })

  it('nudges by a small or a big step, hides at the limit and restores from a hidden panel', () => {
    expect(nudgeState(DEFAULT_SPLIT, 1).ratio).toBeCloseTo(0.53)
    expect(nudgeState(DEFAULT_SPLIT, -1, true).ratio).toBeCloseTo(0.4)
    expect(nudgeState({ ratio: MAX_RATIO, collapsed: null }, 1)).toEqual({
      ratio: MAX_RATIO,
      collapsed: 'second',
    })
    expect(nudgeState({ ratio: MIN_RATIO, collapsed: null }, -1)).toEqual({
      ratio: MIN_RATIO,
      collapsed: 'first',
    })
    // The first push towards the limit only clamps.
    expect(nudgeState({ ratio: 0.21, collapsed: null }, -1)).toEqual({ ratio: MIN_RATIO, collapsed: null })
    expect(nudgeState({ ratio: 0.3, collapsed: 'first' }, 1)).toEqual({ ratio: 0.3, collapsed: null })
    expect(nudgeState({ ratio: 0.3, collapsed: 'first' }, -1)).toEqual({ ratio: 0.3, collapsed: 'first' })
    expect(nudgeState({ ratio: 0.3, collapsed: 'second' }, -1)).toEqual({ ratio: 0.3, collapsed: null })
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

describe('live drag helpers', () => {
  it('says which panel a release would hide, with hysteresis for an already hidden one', () => {
    expect(hideSide(0.5)).toBeNull()
    expect(hideSide(COLLAPSE_AT - 0.01)).toBe('first')
    expect(hideSide(1 - COLLAPSE_AT + 0.01)).toBe('second')
    // Already hidden: a small pull is not enough to bring it back.
    expect(hideSide(COLLAPSE_AT + 0.02, 'first')).toBe('first')
    expect(hideSide(0.3, 'first')).toBeNull()
    expect(hideSide(Number.NaN, 'second')).toBe('second')
  })

  it('reports where the handle is and builds free (unclamped) live tracks', () => {
    expect(handleRatio({ ratio: 0.4, collapsed: null })).toBe(0.4)
    expect(handleRatio({ ratio: 0.4, collapsed: 'first' })).toBe(0)
    expect(handleRatio({ ratio: 0.4, collapsed: 'second' })).toBe(1)
    expect(liveTracks(0.05, 16)).toBe('0.05fr 16px 0.95fr')
    expect(liveTracks(-1, 16)).toBe('0fr 16px 1fr')
    expect(liveTracks(2, 16)).toBe('1fr 16px 0fr')
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
