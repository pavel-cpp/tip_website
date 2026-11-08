import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { prefersReducedMotion } from '../../lib/motion'
import {
  fontSpec,
  PLACEHOLDER_KEYS,
  type PlaceholderKey,
  type TicketPlaceholder,
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

/** Below this stage width only the selected field's handle is shown, so the picture stays readable. */
const NARROW_STAGE = 460
const DOT = 22
const GAP = 14

let measurer: CanvasRenderingContext2D | null | undefined

function textWidth(p: TicketPlaceholder, text: string): number {
  if (measurer === undefined) {
    measurer = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  }
  if (!measurer) return text.length * p.size * 0.6
  measurer.font = fontSpec(p)
  return measurer.measureText(text).width + p.stroke * 2
}

/**
 * Where a handle sits, in stage pixels (its right-middle point). The handle goes to the left of the
 * text so it never covers a glyph; when the text starts too close to the left edge it goes just
 * above the first glyph instead.
 */
export function chipAnchor(p: TicketPlaceholder, text: string, scale: number): Point {
  const left = (p.x - textWidth(p, text) / 2) * scale
  if (left >= DOT + GAP) return { x: left - GAP, y: p.y * scale }
  const above = p.y * scale - (p.size * scale) / 2 - DOT / 2 - 4
  return { x: Math.max(left, 0) + DOT, y: Math.max(above, DOT / 2) }
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

  // Handle positions depend on the measured text width, which changes once a web font has loaded.
  const [, setFontTick] = useState(0)
  useEffect(() => {
    const fonts = typeof document === 'undefined' ? undefined : document.fonts
    if (!fonts?.addEventListener) return
    const bump = () => setFontTick((n) => n + 1)
    fonts.addEventListener('loadingdone', bump)
    return () => fonts.removeEventListener('loadingdone', bump)
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
      data-narrow={shown > 0 && shown < NARROW_STAGE ? '' : undefined}
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
        const at = chipAnchor(p, values[key] || labelOf(key), scale)
        return (
          <button
            key={key}
            ref={(el) => {
              chips.current[key] = el
            }}
            type="button"
            className="ph-chip"
            aria-pressed={active === key}
            aria-label={t('settings.drag', { label: `${labelOf(key)} ${i + 1}` })}
            style={{ transform: `translate(${at.x}px, ${at.y}px) translate(-100%, -50%)` }}
            onPointerDown={onDown(key)}
            onPointerMove={onPointerMove}
            onPointerUp={finish}
            onPointerCancel={finish}
            onKeyDown={onKey(key)}
          >
            <span className="ph-chip-label" aria-hidden="true">
              {labelOf(key)}
            </span>{' '}
            <span className="ph-chip-badge" aria-hidden="true" style={{ background: BADGE[key] }}>
              {i + 1}
            </span>
          </button>
        )
      })}
    </div>
  )
}
