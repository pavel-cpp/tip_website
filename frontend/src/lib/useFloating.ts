import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react'
import { type Align, computePosition, type Placement, type Side } from './position'

/**
 * Positions a fixed-position box next to an anchor element and keeps it there on scroll/resize.
 * Attach the returned ref to the floating element and spread the style on it.
 */
export function useFloating<T extends HTMLElement>(
  open: boolean,
  anchor: HTMLElement | null,
  opts: { side?: Side; align?: Align; gap?: number } = {},
) {
  const ref = useRef<T>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const { side, align, gap } = opts

  useLayoutEffect(() => {
    const box = ref.current
    if (!open || !anchor || !box) {
      setPlacement(null)
      return
    }
    const update = () => {
      const r = anchor.getBoundingClientRect()
      // offsetWidth/Height ignore the scale transform of the opening animation.
      const next = computePosition(
        { top: r.top, left: r.left, width: r.width, height: r.height },
        { width: box.offsetWidth, height: box.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        { side, align, gap },
      )
      setPlacement((prev) =>
        prev && prev.top === next.top && prev.left === next.left && prev.side === next.side ? prev : next,
      )
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, anchor, side, align, gap])

  const style: CSSProperties = placement
    ? { top: placement.top, left: placement.left, transformOrigin: placement.origin }
    : { top: 0, left: 0, visibility: 'hidden' }
  return { ref, style, side: placement?.side ?? side ?? 'bottom' }
}
