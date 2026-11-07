import { readFileSync } from 'node:fs'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyTheme,
  readStoredMode,
  resolveTheme,
  setThemeMode,
  THEME_COLORS,
  THEME_KEY,
  useTheme,
} from './theme'

beforeEach(() => {
  document.head.innerHTML = '<meta name="theme-color" content="#131418">'
})
afterEach(() => vi.restoreAllMocks())

describe('resolveTheme', () => {
  it('maps modes, with system following the OS preference', () => {
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('system', true)).toBe('light')
    expect(resolveTheme('system', false)).toBe('dark')
  })
})

describe('readStoredMode', () => {
  it('defaults to dark and ignores junk', () => {
    expect(readStoredMode()).toBe('dark')
    localStorage.setItem(THEME_KEY, 'purple')
    expect(readStoredMode()).toBe('dark')
    localStorage.setItem(THEME_KEY, 'light')
    expect(readStoredMode()).toBe('light')
  })

  it('survives a throwing localStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readStoredMode()).toBe('dark')
  })
})

describe('applyTheme', () => {
  it('sets data-theme, color-scheme and the theme-color meta together', () => {
    expect(applyTheme('light')).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      THEME_COLORS.light,
    )
    applyTheme('dark')
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      THEME_COLORS.dark,
    )
  })

  it('resolves system through matchMedia', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q) => ({ matches: q.includes('light') }) as MediaQueryList,
    )
    expect(applyTheme('system')).toBe('light')
  })
})

describe('setThemeMode / useTheme', () => {
  it('persists the choice, applies it and re-renders subscribers', () => {
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setMode('light'))
    expect(result.current.mode).toBe('light')
    expect(result.current.resolved).toBe('light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    act(() => setThemeMode('dark'))
    expect(result.current.resolved).toBe('dark')
  })

  it('uses a View Transition when available and skips it for reduced motion', () => {
    const start = vi.fn((cb: () => void) => cb())
    Object.assign(document, { startViewTransition: start })
    setThemeMode('light')
    expect(start).toHaveBeenCalledTimes(1)
    localStorage.setItem('tip.reduceMotion', '1')
    setThemeMode('dark')
    expect(start).toHaveBeenCalledTimes(1)
    Reflect.deleteProperty(document, 'startViewTransition')
  })
})

describe('inline script in index.html', () => {
  const html = readFileSync('index.html', 'utf8')

  it('reads the same storage key and uses the same colours as the module', () => {
    expect(html).toContain(`'${THEME_KEY}'`)
    expect(html).toContain(THEME_COLORS.dark)
    expect(html).toContain(THEME_COLORS.light)
  })

  it('runs before the app bundle so there is no flash', () => {
    const script = html.indexOf("setAttribute('data-theme'")
    expect(script).toBeGreaterThan(-1)
    expect(script).toBeLessThan(html.indexOf('/src/main.tsx'))
  })
})
