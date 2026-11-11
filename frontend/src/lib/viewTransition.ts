import { DURATION, prefersReducedMotion } from './motion'

export function supportsViewTransitions(): boolean {
  return typeof document.startViewTransition === 'function'
}

/**
 * Runs a synchronous DOM/state update (theme or language switch; routes use lib/routeMotion.ts) inside a
 * View Transition when the browser supports it,
 * otherwise applies it and plays a short fade on the root element. Reduced motion skips both.
 */
export function withViewTransition(update: () => void): void {
  if (prefersReducedMotion()) {
    update()
    return
  }
  if (document.startViewTransition) {
    document.startViewTransition(update)
    return
  }
  update()
  const root = document.getElementById('root')
  if (!root) return
  root.classList.remove('vt-fade')
  void root.offsetWidth // restart the animation when called twice in a row
  root.classList.add('vt-fade')
  setTimeout(() => root.classList.remove('vt-fade'), DURATION.fast)
}
