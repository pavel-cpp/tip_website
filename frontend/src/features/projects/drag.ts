// Pure maths for dragging a placeholder over the preview. All coordinates handed back are in
// source-image pixels (docs/06-frontend.md, pitfall 10), whatever size the preview is shown at.

export interface Size {
  w: number
  h: number
}
export interface Point {
  x: number
  y: number
}
export interface ClientRect {
  left: number
  top: number
  width: number
  height: number
}

/** Pointer position on screen to image pixels, given the preview's on-screen rectangle. */
export function clientToImage(clientX: number, clientY: number, rect: ClientRect, image: Size): Point {
  if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 }
  return {
    x: ((clientX - rect.left) / rect.width) * image.w,
    y: ((clientY - rect.top) / rect.height) * image.h,
  }
}

export function clampToImage(p: Point, image: Size): Point {
  return {
    x: Math.round(Math.min(Math.max(p.x, 0), image.w)),
    y: Math.round(Math.min(Math.max(p.y, 0), image.h)),
  }
}

export interface Guides {
  /** x of the vertical guide the position snapped to: an edge, the centre or another field's x. */
  x: number | null
  /** y of the horizontal guide the position snapped to. */
  y: number | null
}

/** Snap threshold: 8 screen pixels expressed in image pixels. */
export function snapThreshold(imageWidth: number, displayedWidth: number, screenPx = 8): number {
  return displayedWidth > 0 ? (screenPx * imageWidth) / displayedWidth : 0
}

function snapAxis(value: number, targets: number[], threshold: number): number | null {
  let best: number | null = null
  let bestDist = threshold
  for (const t of targets) {
    const d = Math.abs(value - t)
    if (d <= bestDist) {
      best = t
      bestDist = d
    }
  }
  return best
}

/** Positions of the other fields; the dragged one also snaps to their centre lines. */
export interface SnapTargets {
  xs?: readonly number[]
  ys?: readonly number[]
}

/**
 * Snaps each axis independently to the centre line, an edge or (with `others`) the centre line of another
 * field when within the threshold.
 */
export function snapPosition(
  p: Point,
  image: Size,
  threshold: number,
  others: SnapTargets = {},
): { point: Point; guides: Guides } {
  const x = snapAxis(p.x, [0, image.w / 2, image.w, ...(others.xs ?? [])], threshold)
  const y = snapAxis(p.y, [0, image.h / 2, image.h, ...(others.ys ?? [])], threshold)
  return {
    point: { x: Math.round(x ?? p.x), y: Math.round(y ?? p.y) },
    guides: { x, y },
  }
}

/** Arrow-key nudge (1 px, 10 px with Shift); null for other keys. */
export function keyDelta(key: string, shift: boolean): Point | null {
  const step = shift ? 10 : 1
  switch (key) {
    case 'ArrowLeft':
      return { x: -step, y: 0 }
    case 'ArrowRight':
      return { x: step, y: 0 }
    case 'ArrowUp':
      return { x: 0, y: -step }
    case 'ArrowDown':
      return { x: 0, y: step }
    default:
      return null
  }
}

/**
 * Drag session: remembers where inside the chip the pointer grabbed it so the chip follows the
 * pointer 1:1 without jumping to its centre.
 */
export function dragPosition(pointer: Point, grabOffset: Point, image: Size): Point {
  return clampToImage({ x: pointer.x - grabOffset.x, y: pointer.y - grabOffset.y }, image)
}
