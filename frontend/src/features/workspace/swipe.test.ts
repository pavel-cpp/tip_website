import { describe, expect, it } from 'vitest'
import { follow, lockAxis, swipeResult, velocity } from './swipe'

describe('swipe maths', () => {
  it('waits for a decisive move before choosing an axis', () => {
    expect(lockAxis(3, 2)).toBeNull()
    expect(lockAxis(12, 4)).toBe('x')
    expect(lockAxis(-3, 14)).toBe('y')
  })

  it('follows the finger 1:1 towards a neighbour and resists at the ends', () => {
    expect(follow(-80, true, true)).toBe(-80)
    expect(follow(80, true, false)).toBe(80)
    expect(follow(-80, true, false)).toBeCloseTo(-24)
    expect(follow(80, false, true)).toBeCloseTo(24)
  })

  const base = { vx: 0, width: 400, canPrev: true, canNext: true }
  it('turns after a long drag: left shows the next ticket, right the previous', () => {
    expect(swipeResult({ ...base, dx: -120 })).toBe('next')
    expect(swipeResult({ ...base, dx: 120 })).toBe('prev')
  })
  it('stays after a short slow drag', () => {
    expect(swipeResult({ ...base, dx: -60 })).toBe('stay')
  })
  it('turns after a short quick flick in the same direction only', () => {
    expect(swipeResult({ ...base, dx: -50, vx: -0.8 })).toBe('next')
    expect(swipeResult({ ...base, dx: -50, vx: 0.8 })).toBe('stay')
    expect(swipeResult({ ...base, dx: -10, vx: -0.9 })).toBe('stay')
  })
  it('never turns towards a missing neighbour', () => {
    expect(swipeResult({ ...base, dx: -200, canNext: false })).toBe('stay')
    expect(swipeResult({ ...base, dx: 200, canPrev: false })).toBe('stay')
  })
  it('measures velocity over the last 100 ms only', () => {
    const s = [
      { t: 0, x: 0 },
      { t: 150, x: 100 },
      { t: 200, x: 130 },
    ]
    expect(velocity(s)).toBeCloseTo(0.6)
    expect(velocity([])).toBe(0)
    expect(velocity([{ t: 5, x: 3 }])).toBe(0)
  })
})
