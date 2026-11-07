export type Side = 'top' | 'bottom'
export type Align = 'start' | 'center' | 'end'

export interface Rect {
  top: number
  left: number
  width: number
  height: number
}

export interface Placement {
  top: number
  left: number
  side: Side
  /** CSS transform-origin pointing back at the anchor, so scale animations grow out of it. */
  origin: string
}

const MARGIN = 8

/** Places a floating box next to an anchor, flipping vertically when it would leave the viewport. */
export function computePosition(
  anchor: Rect,
  box: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: { side?: Side; align?: Align; gap?: number } = {},
): Placement {
  const { align = 'start', gap = 8 } = opts
  let side: Side = opts.side ?? 'bottom'

  const below = anchor.top + anchor.height + gap
  const above = anchor.top - gap - box.height
  const fitsBelow = below + box.height <= viewport.height - MARGIN
  const fitsAbove = above >= MARGIN
  if (side === 'bottom' && !fitsBelow && fitsAbove) side = 'top'
  else if (side === 'top' && !fitsAbove && fitsBelow) side = 'bottom'
  const top = side === 'bottom' ? below : above

  let left = anchor.left
  if (align === 'end') left = anchor.left + anchor.width - box.width
  else if (align === 'center') left = anchor.left + (anchor.width - box.width) / 2
  left = Math.max(MARGIN, Math.min(left, viewport.width - box.width - MARGIN))

  const anchorCenterX = anchor.left + anchor.width / 2
  const originX = Math.max(0, Math.min(box.width, anchorCenterX - left))
  const originY = side === 'bottom' ? 0 : box.height
  return { top: Math.max(MARGIN, top), left, side, origin: `${originX}px ${originY}px` }
}
