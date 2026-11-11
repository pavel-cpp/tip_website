/** Finger travel (px) before the gesture picks an axis; below it a tap stays a tap. */
export const SWIPE_LOCK = 8
/** Share of the picture width the finger must travel to turn the ticket without a flick. */
export const SWIPE_DISTANCE = 0.25
/** A flick faster than this (px/ms) turns the ticket after a short drag. */
export const SWIPE_VELOCITY = 0.4
const SWIPE_MIN_FLICK = 24
/** How much of the finger's travel a ticket without a neighbour follows (rubber band). */
const EDGE_PULL = 0.3

export type Axis = 'x' | 'y'

/** The axis of a gesture once the finger has moved past the lock distance; null while undecided. */
export function lockAxis(dx: number, dy: number): Axis | null {
  if (Math.hypot(dx, dy) < SWIPE_LOCK) return null
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
}

/** Where the ticket sits for a finger offset `dx`: 1:1 towards a neighbour, resisted where there is none. */
export function follow(dx: number, canPrev: boolean, canNext: boolean): number {
  const free = dx > 0 ? canPrev : canNext
  return free ? dx : dx * EDGE_PULL
}

export type SwipeResult = 'prev' | 'next' | 'stay'

/** Finger moving left shows the next ticket, moving right the previous one. */
export function swipeResult(o: {
  dx: number
  /** Horizontal velocity at release, px/ms (negative = left). */
  vx: number
  width: number
  canPrev: boolean
  canNext: boolean
}): SwipeResult {
  const dir = o.dx === 0 ? 0 : o.dx > 0 ? -1 : 1
  const can = dir < 0 ? o.canPrev : dir > 0 ? o.canNext : false
  if (!can) return 'stay'
  const far = Math.abs(o.dx) >= o.width * SWIPE_DISTANCE
  const flick =
    Math.abs(o.vx) >= SWIPE_VELOCITY &&
    Math.abs(o.dx) >= SWIPE_MIN_FLICK &&
    Math.sign(o.vx) === Math.sign(o.dx)
  return far || flick ? (dir < 0 ? 'prev' : 'next') : 'stay'
}

/** Velocity (px/ms) over the last `windowMs` of samples; 0 when the finger rested. */
export function velocity(samples: readonly { t: number; x: number }[], windowMs = 100): number {
  const last = samples[samples.length - 1]
  if (!last) return 0
  const first = samples.find((s) => last.t - s.t <= windowMs)
  if (!first || first === last || last.t === first.t) return 0
  return (last.x - first.x) / (last.t - first.t)
}
