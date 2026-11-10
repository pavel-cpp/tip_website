import { useEffect, useState, useSyncExternalStore } from 'react'
import { readStorage, writeStorage } from './storage'

// Mirrors the CSS motion tokens in styles/tokens.css (docs/06-frontend.md, section 10.2).
export const DURATION = { press: 80, fast: 140, base: 220, slow: 360 } as const
// Mirrors --ease-out, --ease-in-out and --ease-drawer for Web Animations API calls.
export const EASE = {
  out: 'cubic-bezier(0.23, 1, 0.32, 1)',
  inOut: 'cubic-bezier(0.77, 0, 0.175, 1)',
  drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
} as const
export const SPRING = { stiffness: 420, damping: 34 } as const

const KEY = 'tip.reduceMotion'
const QUERY = '(prefers-reduced-motion: reduce)'
const listeners = new Set<() => void>()

export function getReduceMotionSetting(): boolean {
  return readStorage(KEY) === '1'
}

function applyAttribute(on: boolean): void {
  const root = document.documentElement
  if (on) root.setAttribute('data-reduce-motion', 'true')
  else root.removeAttribute('data-reduce-motion')
}

export function setReduceMotionSetting(on: boolean): void {
  writeStorage(KEY, on ? '1' : '0')
  applyAttribute(on)
  for (const l of listeners) l()
}

export function initMotionSetting(): void {
  applyAttribute(getReduceMotionSetting())
}

function systemPrefersReduced(): boolean {
  return typeof matchMedia === 'function' && matchMedia(QUERY).matches
}

/** True when JS-driven animation must be skipped: OS preference or the in-app "less motion" setting. */
export function prefersReducedMotion(): boolean {
  return getReduceMotionSetting() || systemPrefersReduced()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  const mq = typeof matchMedia === 'function' ? matchMedia(QUERY) : null
  mq?.addEventListener('change', cb)
  return () => {
    listeners.delete(cb)
    mq?.removeEventListener('change', cb)
  }
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false)
}

export function useReduceMotionSetting(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, getReduceMotionSetting, () => false)
  return [on, setReduceMotionSetting]
}

/**
 * Keeps an element mounted for `exitMs` after `open` turns false so a CSS exit animation can play.
 * Returns whether to render and the data-state to put on the element.
 */
export function usePresence(
  open: boolean,
  exitMs: number = DURATION.fast,
): { mounted: boolean; state: 'open' | 'closed' } {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    const id = setTimeout(() => setMounted(false), prefersReducedMotion() ? 100 : exitMs)
    return () => clearTimeout(id)
  }, [open, exitMs])
  return { mounted: open || mounted, state: open ? 'open' : 'closed' }
}

/**
 * Loads the animation library on first use so it stays out of the initial bundle.
 * Used for spring and layout animation that CSS cannot express.
 */
export async function loadMotion() {
  return import('motion/mini')
}
