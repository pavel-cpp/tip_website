import { EASE } from '../../lib/motion'

/**
 * The ticket pictures sit on one strip: the one on screen and, right behind it, the neighbour in the direction of
 * travel. Dragging, an arrow press and a key all move the strip the same way; only transform is animated.
 */

/** How many times faster than its average speed EASE.out starts (y1 / x1 of its cubic-bezier). */
const OUT_SLOPE = 4.35
const MIN_MS = 160

/**
 * How long the rest of a slide takes. Without a release speed (arrow, key, slow drag) a full-width slide takes
 * 290 ms and a shorter one proportionally less; a fast flick continues at the speed it was released with.
 * `distance` and `width` in px, `speed` in px/ms along the travel.
 */
export function slideDuration(distance: number, width: number, speed = 0): number {
  const base = 200 + 90 * Math.min(1, Math.max(0, distance) / Math.max(1, width))
  if (speed < 0.2 || distance <= 0) return Math.round(base)
  return Math.round(Math.min(base, Math.max(MIN_MS, (distance * OUT_SLOPE) / speed)))
}

/** Where the neighbour waits: one picture width beyond the one on screen, towards `dir` (1 = next, -1 = previous). */
export const neighbourAt = (offset: number, dir: 1 | -1, width: number): number => offset + dir * width

export interface Leg {
  el: HTMLElement
  from: number
  to: number
}

/** Starts one transform animation per leg, all with the same timing so they move as one strip. */
export function runLegs(legs: readonly Leg[], ms: number): Animation[] {
  return legs.map(({ el, from, to }) =>
    el.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], {
      duration: ms,
      easing: EASE.out,
      fill: 'forwards',
    }),
  )
}
