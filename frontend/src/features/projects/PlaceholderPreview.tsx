import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { prefersReducedMotion } from '../../lib/motion'
import {
  PLACEHOLDER_KEYS,
  type PlaceholderKey,
  type TicketPlaceholders,
  type TicketValues,
  useTicketCanvas,
} from '../../lib/ticket'
import {
  clientToImage,
  dragPosition,
  type Guides,
  keyDelta,
  type Point,
  snapPosition,
  snapThreshold,
} from './drag'
import './settings.css'

interface Props {
  image: HTMLImageElement | null
  /** Intrinsic image size in pixels (from the project, available before the bitmap is decoded). */
  size: { w: number; h: number }
  placeholders: TicketPlaceholders
  values: TicketValues
  active: PlaceholderKey
  onSelect: (key: PlaceholderKey) => void
  onMove: (key: PlaceholderKey, point: Point) => void
  disabled?: boolean
}

const BADGE: Record<PlaceholderKey, string> = {
  number: 'var(--user-2)',
  name: 'var(--user-4)',
  phone: 'var(--user-3)',
}

interface Session {
  key: PlaceholderKey
  pointerId: number
  grab: Point
  raw: Point
  start: Point
}

/**
 * Live ticket preview with draggable placeholder chips. While dragging the chip follows the pointer
 * 1:1 (no easing); guides fade in near the centre/edges; on release the position snaps and the chip
 * settles with a short overshoot (skipped under reduced motion).
 */
export function PlaceholderPreview({
  image,
  size,
  placeholders,
  values,
  active,
  onSelect,
  onMove,
  disabled,
}: Props) {
  const { t } = useI18n()
  const stage = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const chips = useRef<Partial<Record<PlaceholderKey, HTMLButtonElement | null>>>({})
  const session = useRef<Session | null>(null)
  const [shown, setShown] = useState(0)
  const [guides, setGuides] = useState<Guides>({ x: null, y: null })

  useTicketCanvas(canvas, image, placeholders, values)

  useEffect(() => {
    const el = stage.current
    if (!el) return
    setShown(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setShown(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const scale = size.w > 0 ? shown / size.w : 0
  const labelOf = (k: PlaceholderKey) => t(k === 'phone' ? 'settings.ph.phoneFull' : `settings.ph.${k}`)

  const pointerImg = (e: PointerEvent): Point => {
    const r = stage.current?.getBoundingClientRect()
    return r ? clientToImage(e.clientX, e.clientY, r, size) : { x: 0, y: 0 }
  }

  const onDown = (key: PlaceholderKey) => (e: PointerEvent<HTMLButtonElement>) => {
    onSelect(key)
    if (disabled || e.button !== 0) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const p = placeholders[key]
    const ptr = pointerImg(e)
    session.current = {
      key,
      pointerId: e.pointerId,
      grab: { x: ptr.x - p.x, y: ptr.y - p.y },
      raw: { x: p.x, y: p.y },
      start: { x: p.x, y: p.y },
    }
  }

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const s = session.current
    if (!s || s.pointerId !== e.pointerId) return
    s.raw = dragPosition(pointerImg(e), s.grab, size)
    onMove(s.key, s.raw)
    setGuides(snapPosition(s.raw, size, snapThreshold(size.w, shown)).guides)
  }

  const finish = (e: PointerEvent<HTMLButtonElement>) => {
    const s = session.current
    if (!s || s.pointerId !== e.pointerId) return
    session.current = null
    const snapped = snapPosition(s.raw, size, snapThreshold(size.w, shown)).point
    setGuides({ x: null, y: null })
    if (snapped.x === s.raw.x && snapped.y === s.raw.y) return
    onMove(s.key, snapped)
    const el = chips.current[s.key]
    if (el && !prefersReducedMotion() && typeof el.animate === 'function') {
      // The individual `translate` property composes with the positioning `transform`.
      el.animate(
        [
          { translate: `${(s.raw.x - snapped.x) * scale}px ${(s.raw.y - snapped.y) * scale}px` },
          { translate: '0 0' },
        ],
        { duration: 280, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
      )
    }
  }

  const onKey = (key: PlaceholderKey) => (e: KeyboardEvent) => {
    const d = keyDelta(e.key, e.shiftKey)
    if (!d || disabled) return
    e.preventDefault()
    const p = placeholders[key]
    onMove(key, {
      x: Math.min(Math.max(p.x + d.x, 0), size.w),
      y: Math.min(Math.max(p.y + d.y, 0), size.h),
    })
  }

  const xGuides = [0, size.w / 2, size.w]
  const yGuides = [0, size.h / 2, size.h]

  return (
    <div
      ref={stage}
      className="ph-stage"
      style={{ aspectRatio: `${size.w} / ${size.h}` }}
      data-disabled={disabled || undefined}
    >
      <canvas ref={canvas} className="ph-canvas" role="img" aria-label={t('settings.preview.label')} />
      {xGuides.map((x) => (
        <span
          key={`x${x}`}
          className="ph-guide ph-guide-v"
          data-on={guides.x === x || undefined}
          style={{ transform: `translateX(${Math.min(x * scale, shown - 1)}px)` }}
        />
      ))}
      {yGuides.map((y) => (
        <span
          key={`y${y}`}
          className="ph-guide ph-guide-h"
          data-on={guides.y === y || undefined}
          style={{ transform: `translateY(${Math.min(y * scale, shown * (size.h / size.w) - 1)}px)` }}
        />
      ))}
      {PLACEHOLDER_KEYS.map((key, i) => {
        const p = placeholders[key]
        return (
          <button
            key={key}
            ref={(el) => {
              chips.current[key] = el
            }}
            type="button"
            className="ph-chip"
            aria-pressed={active === key}
            aria-label={t('settings.drag', { label: labelOf(key) })}
            style={{
              transform: `translate(${p.x * scale}px, ${p.y * scale}px) translate(-50%, calc(-100% - ${(p.size * scale) / 2 + 6}px))`,
            }}
            onPointerDown={onDown(key)}
            onPointerMove={onPointerMove}
            onPointerUp={finish}
            onPointerCancel={finish}
            onKeyDown={onKey(key)}
          >
            <span className="ph-chip-badge" style={{ background: BADGE[key] }}>
              {i + 1}
            </span>
            {labelOf(key)}
          </button>
        )
      })}
    </div>
  )
}
