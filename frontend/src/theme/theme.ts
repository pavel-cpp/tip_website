import { useSyncExternalStore } from 'react'
import { readStorage, writeStorage } from '../lib/storage'
import { withViewTransition } from '../lib/viewTransition'

export type ThemeMode = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

export const THEME_MODES: readonly ThemeMode[] = ['dark', 'light', 'system']
export const THEME_KEY = 'tip.theme'
// Keep in sync with --meta-theme-color in tokens.css and with the inline script in index.html.
export const THEME_COLORS: Record<ResolvedTheme, string> = { dark: '#131418', light: '#f4f5f8' }

const LIGHT_QUERY = '(prefers-color-scheme: light)'
const listeners = new Set<() => void>()
let mode: ThemeMode = 'dark'

function isMode(v: unknown): v is ThemeMode {
  return v === 'dark' || v === 'light' || v === 'system'
}

export function readStoredMode(): ThemeMode {
  const v = readStorage(THEME_KEY)
  return isMode(v) ? v : 'dark'
}

export function resolveTheme(m: ThemeMode, systemLight: boolean): ResolvedTheme {
  if (m === 'system') return systemLight ? 'light' : 'dark'
  return m
}

function systemIsLight(): boolean {
  return typeof matchMedia === 'function' && matchMedia(LIGHT_QUERY).matches
}

/** Tab icon file for a mode: 'system' keeps the OS-adaptive favicon, an explicit choice a fixed one. */
export function iconHref(m: ThemeMode, resolved: ResolvedTheme): string {
  return m === 'system' ? '/favicon.svg' : `/favicon-${resolved}.svg`
}

/** Writes data-theme, color-scheme, the browser chrome colour and the tab icon for the given mode. */
export function applyTheme(m: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(m, systemIsLight())
  const root = document.documentElement
  root.setAttribute('data-theme', resolved)
  root.style.colorScheme = resolved
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[resolved])
  document.querySelector('link[rel="icon"]')?.setAttribute('href', iconHref(m, resolved))
  return resolved
}

function notify(): void {
  for (const l of listeners) l()
}

export function getThemeMode(): ThemeMode {
  return mode
}

export function getResolvedTheme(): ResolvedTheme {
  return resolveTheme(mode, systemIsLight())
}

/** Switches theme with a cross-fade (skipped for reduced motion) and persists the choice. */
export function setThemeMode(next: ThemeMode): void {
  mode = next
  writeStorage(THEME_KEY, next)
  withViewTransition(() => applyTheme(next))
  notify()
}

/** Call once at startup. The inline script in index.html has already set data-theme before paint. */
export function initTheme(): void {
  mode = readStoredMode()
  applyTheme(mode)
  if (typeof matchMedia === 'function') {
    matchMedia(LIGHT_QUERY).addEventListener('change', () => {
      if (mode !== 'system') return
      applyTheme(mode)
      notify()
    })
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// The snapshot is a string so useSyncExternalStore compares by value.
const snapshot = (): string => `${mode}:${getResolvedTheme()}`

export function useTheme(): { mode: ThemeMode; resolved: ResolvedTheme; setMode: (m: ThemeMode) => void } {
  const [m, resolved] = useSyncExternalStore(subscribe, snapshot, snapshot).split(':') as [
    ThemeMode,
    ResolvedTheme,
  ]
  return { mode: m, resolved, setMode: setThemeMode }
}
