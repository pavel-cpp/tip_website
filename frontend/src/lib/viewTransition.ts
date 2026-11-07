import { DURATION, prefersReducedMotion } from './motion'

type DocWithVT = Document & { startViewTransition?: (cb: () => void | Promise<void>) => unknown }

export function supportsViewTransitions(): boolean {
  return typeof (document as DocWithVT).startViewTransition === 'function'
}

/**
 * Runs a synchronous DOM/state update inside a View Transition when the browser supports it,
 * otherwise applies it and plays a short fade on the root element. Reduced motion skips both.
 */
export function withViewTransition(update: () => void): void {
  if (prefersReducedMotion()) {
    update()
    return
  }
  const doc = document as DocWithVT
  if (doc.startViewTransition) {
    doc.startViewTransition(update)
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
