import { type RefObject, useLayoutEffect, useRef } from 'react'
import { DURATION, prefersReducedMotion } from '../../lib/motion'
import { flipDelta } from './logic'

export interface FlipApi {
  /**
   * A dragged card was let go at `rect`: on the next render it glides from there to its new slot,
   * and its inline drag transform is removed in the same frame so there is no flash at home.
   */
  release: (id: string, rect: { left: number; top: number }) => void
}

/**
 * FLIP layout animation for children marked `data-flip-id` inside `container`: after every render
 * each element that moved is translated back to its old position (transform only) and released,
 * so reordering, filtering and moving between sections glide instead of jumping.
 * Uses the Web Animations API directly; no animation library is needed for this.
 * While `paused` (a drag in progress) nothing is measured or animated.
 */
export function useFlip(container: RefObject<HTMLElement | null>, paused = false): FlipApi {
  const previous = useRef(new Map<string, { left: number; top: number }>())
  const released = useRef<{ id: string; rect: { left: number; top: number } } | null>(null)

  // No dependency list on purpose: positions can change on any render of the owning component.
  useLayoutEffect(() => {
    const root = container.current
    if (!root || paused) return
    const drop = released.current
    released.current = null
    if (drop) {
      const el = root.querySelector<HTMLElement>(`[data-flip-id="${CSS.escape(drop.id)}"]`)
      if (el) el.style.transform = ''
      previous.current.set(drop.id, drop.rect)
    }
    const next = new Map<string, { left: number; top: number }>()
    const animate = !prefersReducedMotion()
    for (const el of root.querySelectorAll<HTMLElement>('[data-flip-id]')) {
      const id = el.dataset.flipId as string
      const r = el.getBoundingClientRect()
      next.set(id, { left: r.left, top: r.top })
      const before = previous.current.get(id)
      if (!before || !animate || typeof el.animate !== 'function') continue
      const delta = flipDelta(before, r)
      if (!delta) continue
      el.animate(
        [{ transform: `translate(${delta.dx}px, ${delta.dy}px)` }, { transform: 'translate(0, 0)' }],
        { duration: DURATION.slow, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
      )
    }
    previous.current = next
  })

  const api = useRef<FlipApi>({
    release: (id, rect) => {
      released.current = { id, rect }
    },
  })
  return api.current
}
