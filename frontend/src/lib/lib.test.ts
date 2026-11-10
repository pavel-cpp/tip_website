import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getReduceMotionSetting,
  prefersReducedMotion,
  setReduceMotionSetting,
  usePresence,
  useReduceMotionSetting,
} from './motion'
import { computePosition } from './position'
import { withViewTransition } from './viewTransition'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'startViewTransition')
})

describe('reduce motion setting', () => {
  it('persists, sets data-reduce-motion and informs prefersReducedMotion', () => {
    expect(prefersReducedMotion()).toBe(false)
    const { result } = renderHook(() => useReduceMotionSetting())
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
    expect(getReduceMotionSetting()).toBe(true)
    expect(localStorage.getItem('tip.reduceMotion')).toBe('1')
    expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('true')
    expect(prefersReducedMotion()).toBe(true)
    act(() => setReduceMotionSetting(false))
    expect(document.documentElement.hasAttribute('data-reduce-motion')).toBe(false)
  })

  it('also honours the OS media query', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q) =>
        ({
          matches: q.includes('reduce'),
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    )
    expect(prefersReducedMotion()).toBe(true)
  })
})

describe('usePresence', () => {
  it('keeps the element mounted for the exit duration', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ open }) => usePresence(open, 140), {
      initialProps: { open: true },
    })
    expect(result.current).toEqual({ mounted: true, state: 'open' })
    rerender({ open: false })
    expect(result.current).toEqual({ mounted: true, state: 'closed' })
    act(() => vi.advanceTimersByTime(141))
    expect(result.current.mounted).toBe(false)
  })

  it('keeps a 100 ms exit under reduced motion so the opacity fade can play', () => {
    vi.useFakeTimers()
    localStorage.setItem('tip.reduceMotion', '1')
    const { result, rerender } = renderHook(({ open }) => usePresence(open, 400), {
      initialProps: { open: true },
    })
    rerender({ open: false })
    act(() => vi.advanceTimersByTime(99))
    expect(result.current.mounted).toBe(true)
    act(() => vi.advanceTimersByTime(2))
    expect(result.current.mounted).toBe(false)
    localStorage.removeItem('tip.reduceMotion')
  })
})

describe('withViewTransition', () => {
  it('uses document.startViewTransition when supported', () => {
    const start = vi.fn((cb: () => void) => cb())
    Object.assign(document, { startViewTransition: start })
    const update = vi.fn()
    withViewTransition(update)
    expect(start).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledOnce()
  })

  it('falls back to a root fade without the API', () => {
    document.body.innerHTML = '<div id="root"></div>'
    const update = vi.fn()
    withViewTransition(update)
    expect(update).toHaveBeenCalledOnce()
    expect(document.getElementById('root')).toHaveClass('vt-fade')
  })

  it('applies the update directly for reduced motion', () => {
    localStorage.setItem('tip.reduceMotion', '1')
    const start = vi.fn()
    Object.assign(document, { startViewTransition: start })
    const update = vi.fn()
    withViewTransition(update)
    expect(update).toHaveBeenCalledOnce()
    expect(start).not.toHaveBeenCalled()
  })
})

describe('computePosition', () => {
  const viewport = { width: 1000, height: 800 }
  const box = { width: 200, height: 100 }

  it('places below the anchor, aligned to its end, with an origin at the anchor', () => {
    const p = computePosition({ top: 100, left: 700, width: 40, height: 40 }, box, viewport, { align: 'end' })
    expect(p).toMatchObject({ side: 'bottom', top: 148, left: 540 })
    expect(p.origin).toBe('180px 0px')
  })

  it('flips above when there is no room below', () => {
    const p = computePosition({ top: 720, left: 100, width: 40, height: 40 }, box, viewport)
    expect(p.side).toBe('top')
    expect(p.top).toBe(720 - 8 - 100)
    expect(p.origin.endsWith('100px')).toBe(true)
  })

  it('clamps horizontally into the viewport', () => {
    expect(computePosition({ top: 0, left: 950, width: 40, height: 40 }, box, viewport).left).toBe(792)
    expect(
      computePosition({ top: 0, left: -50, width: 40, height: 40 }, box, viewport, { align: 'center' }).left,
    ).toBe(8)
  })
})
