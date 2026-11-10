import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
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
  type SnapTargets,
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
}

/**
 * Live ticket preview with draggable placeholder chips. While dragging, the field follows the pointer
 * 1:1 (no easing) and magnetically snaps to the centre lines, the edges and the other fields' lines, with
 * a guide drawn where it snapped; holding Alt turns snapping off for pixel-precise placement. The arrow
 * keys nudge the focused handle by 1 px (10 px with Shift).
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
    }
  }

  const othersOf = (key: PlaceholderKey): SnapTargets => {
    const rest = PLACEHOLDER_KEYS.filter((k) => k !== key).map((k) => placeholders[k])
    return { xs: rest.map((p) => p.x), ys: rest.map((p) => p.y) }
  }

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const s = session.current
    if (!s || s.pointerId !== e.pointerId) return
    const raw = dragPosition(pointerImg(e), s.grab, size)
    if (e.altKey) {
      setGuides({ x: null, y: null })
      onMove(s.key, raw)
      return
    }
    const snapped = snapPosition(raw, size, snapThreshold(size.w, shown), othersOf(s.key))
    setGuides(snapped.guides)
    onMove(s.key, snapped.point)
  }

  const finish = (e: PointerEvent<HTMLButtonElement>) => {
    const s = session.current
    if (!s || s.pointerId !== e.pointerId) return
    session.current = null
    setGuides({ x: null, y: null })
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

  return (
    <div
      ref={stage}
      className="ph-stage"
      style={{ aspectRatio: `${size.w} / ${size.h}` }}
      data-disabled={disabled || undefined}
      data-narrow={shown > 0 && shown < NARROW_STAGE ? '' : undefined}
    >
      <canvas ref={canvas} className="ph-canvas" role="img" aria-label={t('settings.preview.label')} />
      {guides.x !== null && (
        <span
          className="ph-guide ph-guide-v"
          style={{ transform: `translateX(${Math.min(guides.x * scale, shown - 1)}px)` }}
        />
      )}
      {guides.y !== null && (
        <span
          className="ph-guide ph-guide-h"
          style={{ transform: `translateY(${Math.min(guides.y * scale, shown * (size.h / size.w) - 1)}px)` }}
        />
      )}
      {PLACEHOLDER_KEYS.map((key, i) => {
        const p = placeholders[key]
        const at = chipAnchor(p, values[key] || labelOf(key), scale)
        return (
          <button
            key={key}
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
