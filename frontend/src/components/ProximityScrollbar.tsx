import { type RefObject, useEffect, useRef } from 'react'

/** Visible width of the thumb at rest: what the native scrollbar thumb is (10px gutter, 2px transparent border). */
const BASE = 6
/** Visible width when the pointer is on the scrollbar. */
const WIDE = 15
/** The thumb starts to grow when the pointer is this close (px) to the scrollbar side of the area. */
const NEAR = 90
const MIN_THUMB = 28

interface Props {
  /** The scrolling element. Its native thumb is hidden (`data-psb`), its gutter stays, so the layout does not change. */
  target: RefObject<HTMLElement | null>
  /** Anything that changes the height of the content without resizing the element (row count and the like). */
  watch?: unknown
}

/**
 * A scrollbar that swells towards the pointer: thin as the native one while the pointer is far away, wider and
 * darker as it comes near, and easy to grab when it is on it. It is drawn over the native gutter, which keeps its
 * width, and takes over dragging; the wheel and the keyboard keep scrolling the element itself. Only used with a
 * fine pointer and a classic (space-taking) scrollbar; elsewhere the native one is left alone.
 * Place it as the next sibling of the scroller inside a `position: relative` box that has the scroller's size.
 */
export function ProximityScrollbar({ target, watch }: Props) {
  const rail = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = target.current
    const railEl = rail.current
    const thumbEl = thumb.current
    const box = railEl?.parentElement
    if (!el || !railEl || !thumbEl || !box) return
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return

    let near = 0 // 0..1, how close the pointer is
    let dragging = false
    let thumbH = 0
    let travel = 0 // how far the thumb can move, px

    const paint = () => {
      const p = dragging ? 1 : near
      const scale = (BASE + (WIDE - BASE) * p) / WIDE
      const y = travel > 0 ? (el.scrollTop / (el.scrollHeight - el.clientHeight)) * travel : 0
      thumbEl.style.transform = `translateY(${y}px) scaleX(${scale})`
      thumbEl.toggleAttribute('data-near', p > 0.5)
    }

    const measure = () => {
      const gutter = el.offsetWidth - el.clientWidth
      if (gutter <= 0) {
        // Overlay scrollbars: the native one is fine.
        delete el.dataset.psb
        railEl.hidden = true
        return
      }
      el.dataset.psb = ''
      railEl.style.setProperty('--psb-gutter', `${gutter}px`)
      const over = el.scrollHeight > el.clientHeight + 1
      railEl.hidden = !over
      if (!over) return
      const track = el.clientHeight
      thumbH = Math.max(MIN_THUMB, Math.round((el.clientHeight / el.scrollHeight) * track))
      travel = Math.max(0, track - thumbH)
      thumbEl.style.height = `${thumbH}px`
      paint()
    }

    const onMove = (e: PointerEvent) => {
      const r = box.getBoundingClientRect()
      const d = r.right - e.clientX
      const inside = e.clientY >= r.top && e.clientY <= r.bottom && d >= 0
      const p = inside ? Math.min(1, Math.max(0, 1 - d / NEAR)) : 0
      near = p * p // the swelling gathers speed as the pointer gets close
      paint()
    }
    const onLeave = () => {
      near = 0
      paint()
    }

    let startY = 0
    let startTop = 0
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      dragging = true
      startY = e.clientY
      startTop = el.scrollTop
      thumbEl.setPointerCapture(e.pointerId)
      thumbEl.dataset.drag = ''
      paint()
    }
    const onDrag = (e: PointerEvent) => {
      if (!dragging || travel <= 0) return
      el.scrollTop = startTop + ((e.clientY - startY) * (el.scrollHeight - el.clientHeight)) / travel
    }
    const onUp = (e: PointerEvent) => {
      if (!dragging) return
      dragging = false
      if (thumbEl.hasPointerCapture(e.pointerId)) thumbEl.releasePointerCapture(e.pointerId)
      delete thumbEl.dataset.drag
      onMove(e)
    }
    // The thumb sits above the scroller, so a wheel turn over it has to be handed on.
    const onWheel = (e: WheelEvent) => el.scrollBy({ top: e.deltaY, left: e.deltaX })

    measure()
    el.addEventListener('scroll', paint, { passive: true })
    box.addEventListener('pointermove', onMove)
    box.addEventListener('pointerleave', onLeave)
    thumbEl.addEventListener('pointerdown', onDown)
    thumbEl.addEventListener('pointermove', onDrag)
    thumbEl.addEventListener('pointerup', onUp)
    thumbEl.addEventListener('pointercancel', onUp)
    thumbEl.addEventListener('wheel', onWheel, { passive: true })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    if (el.firstElementChild) ro?.observe(el.firstElementChild)
    return () => {
      el.removeEventListener('scroll', paint)
      box.removeEventListener('pointermove', onMove)
      box.removeEventListener('pointerleave', onLeave)
      thumbEl.removeEventListener('pointerdown', onDown)
      thumbEl.removeEventListener('pointermove', onDrag)
      thumbEl.removeEventListener('pointerup', onUp)
      thumbEl.removeEventListener('pointercancel', onUp)
      thumbEl.removeEventListener('wheel', onWheel)
      ro?.disconnect()
      delete el.dataset.psb
    }
  }, [target, watch])

  return (
    <div ref={rail} className="psb-rail" aria-hidden="true" hidden>
      <div ref={thumb} className="psb-thumb" />
    </div>
  )
}
