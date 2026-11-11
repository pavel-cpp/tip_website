import { type CSSProperties, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { AppLink } from '../../components/AppLink'
import { Button } from '../../components/Button'
import { useI18n } from '../../i18n'
import { prefersReducedMotion } from '../../lib/motion'
import {
  imageSize,
  loadFonts,
  renderTicket,
  renderTicketBlob,
  type TicketImage,
  type TicketPlaceholders,
} from '../../lib/ticket'
import type { Participant } from './api'
import { WsIcon } from './icons'
import { type Axis, follow, lockAxis, swipeResult, velocity } from './swipe'
import { ticketValues } from './ticketActions'
import { type Leg, neighbourAt, runLegs, slideDuration } from './ticketStrip'

export const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3] as const
const DEFAULT_ZOOM = 1

/** Canvases of the strip: the one on screen, the one arriving and one still leaving when steps come quickly. */
const POOL = 3

export function nextZoom(current: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > current) ?? current
  return [...ZOOM_STEPS].reverse().find((z) => z < current) ?? current
}

interface TicketPanelProps {
  image: TicketImage | null
  /** The project has an image but it is still downloading or decoding. */
  imageLoading: boolean
  hasProjectImage: boolean
  placeholders: TicketPlaceholders | null
  participant: Participant | null
  /** Why there is no participant to show; picks the wording of the empty state. */
  emptyReason?: 'select' | 'no-rows' | 'error'
  onRetry?: () => void
  /** Where the project settings live; when set, the "no image" state links there (admins). */
  settingsTo?: string
  /** Inside the phone sheet: just the ticket, no zoom controls. */
  compact?: boolean
  /** Shared-element key of the picture (lib/routeMotion.ts), e.g. `ticket:<projectId>`. */
  morph?: string
  /** Picture-only mode: arrows to the previous/next participant and a "number, name" indicator. */
  nav?: TicketNav
  /** Set while a held key repeats: tickets swap with no turn (read when the new ticket is drawn). */
  instantRef?: RefObject<boolean>
}

export interface TicketNav {
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
  /** The neighbours, so a drag can show them next to the current ticket before it is released. */
  prevRow?: Participant | null
  nextRow?: Participant | null
}

/** Inline styles that put a canvas on the strip (above the CSS cross-fade, which only serves plain swaps). */
const stripStyle = (el: HTMLElement, x: number) => {
  el.style.transition = 'none'
  el.style.opacity = '1'
  el.style.transform = `translateX(${x}px)`
}
/** A canvas off the strip: invisible and in its slot, with no fade that could flash it. */
const hideEl = (el: HTMLElement) => {
  el.style.transition = 'none'
  el.style.opacity = '0'
  el.style.transform = ''
}
/** Back under the control of the stylesheet (cross-fade by `data-front`). */
const releaseEl = (el: HTMLElement) => {
  el.style.removeProperty('transition')
  el.style.removeProperty('opacity')
  el.style.removeProperty('transform')
}
const offsetOf = (el: HTMLElement): number => {
  const tf = getComputedStyle(el).transform
  return tf && tf !== 'none' ? new DOMMatrix(tf).m41 : 0
}

/**
 * Draws the current participant on two stacked canvases. A new ticket is rendered into the hidden one
 * and only swapped in (opacity cross-fade) when it is complete, so the old image never flickers away.
 */
export function TicketPanel({
  image,
  imageLoading,
  hasProjectImage,
  placeholders,
  participant,
  emptyReason = 'select',
  onRetry,
  settingsTo,
  compact = false,
  nav,
  instantRef,
  morph,
}: TicketPanelProps) {
  const { t, formatNumber } = useI18n()
  const canvases = [
    useRef<HTMLCanvasElement>(null),
    useRef<HTMLCanvasElement>(null),
    useRef<HTMLCanvasElement>(null),
  ]
  const [front, setFront] = useState(0)
  const [drawn, setDrawn] = useState(false)
  const frontRef = useRef(0)
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  // The ticket shown last, for the direction of the slide.
  const shownNumber = useRef<number | null>(null)
  const animate = nav !== undefined
  const navRef = useRef(nav)
  navRef.current = nav
  const sourceRef = useRef({ image, placeholders })
  sourceRef.current = { image, placeholders }

  // The strip: slides still running (one animation per canvas), the neighbour a drag has drawn, the finger.
  const running = useRef(new Map<HTMLCanvasElement, Animation>())
  const neighbour = useRef<{ idx: number; dir: 1 | -1; number: number } | null>(null)
  /** A swipe was released past the threshold: this ticket is already on the strip and takes the front when drawn. */
  const committed = useRef<{ idx: number; number: number } | null>(null)
  const swipe = useRef<{
    px: number
    py: number
    from: number
    axis: Axis | null
    el: HTMLCanvasElement | null
    off: number
    dx: number
    samples: { t: number; x: number }[]
  } | null>(null)

  const els = () => canvases.map((c) => c.current)
  /** Stops a canvas' slide where it is and says where that was. */
  const grab = (el: HTMLCanvasElement): number => {
    const x = offsetOf(el)
    running.current.get(el)?.cancel()
    running.current.delete(el)
    return x
  }
  /** Puts a leaving canvas away; an arriving one goes back to the stylesheet. */
  const park = (el: HTMLCanvasElement, idx: number) => {
    running.current.get(el)?.cancel()
    running.current.delete(el)
    if (idx === frontRef.current) releaseEl(el)
    else hideEl(el)
  }
  /** Ends every slide at once (a plain swap, a lost race, unmount). */
  const settleAll = () => {
    els().forEach((el, i) => {
      if (el && (running.current.has(el) || el.style.transform)) park(el, i)
    })
    neighbour.current = null
  }
  /** A canvas that is neither on screen nor on the strip. */
  const freeIdx = (): number => {
    const busy = (i: number) =>
      i === frontRef.current ||
      i === neighbour.current?.idx ||
      (els()[i] && running.current.has(els()[i] as HTMLCanvasElement))
    let i = Array.from({ length: POOL }, (_, k) => k).find((k) => !busy(k))
    if (i === undefined) {
      settleAll()
      i = Array.from({ length: POOL }, (_, k) => k).find((k) => k !== frontRef.current) ?? 0
    }
    return i
  }
  /** Runs legs as one strip and parks each canvas when the slide ends. */
  const slide = (legs: Leg[], ms: number) => {
    const anims = runLegs(legs, ms)
    legs.forEach((leg, k) => {
      const el = leg.el as HTMLCanvasElement
      const a = anims[k] as Animation
      running.current.set(el, a)
      a.finished.then(
        () => {
          if (running.current.get(el) !== a) return
          const idx = els().indexOf(el)
          // Cleared in the same task as the cancel, so no frame shows the canvas in the wrong place.
          if (idx === frontRef.current) releaseEl(el)
          else hideEl(el)
          running.current.delete(el)
          a.cancel()
          if (running.current.size === 0) setRegen((v) => v + 1)
        },
        () => undefined,
      )
    })
  }
  useEffect(() => () => settleAll(), [])

  const values = useMemo(() => (participant ? ticketValues(participant) : null), [participant])
  const { number, name, phone } = values ?? { number: '', name: '', phone: '' }
  const size = image ? imageSize(image) : null

  useEffect(() => {
    if (!image || !placeholders || !values) {
      setDrawn(false)
      return
    }
    let live = true
    void loadFonts(placeholders).then(() => {
      if (!live) return
      requestAnimationFrame(() => {
        if (!live) return
        const shown = Number(number)
        const prev = shownNumber.current
        shownNumber.current = shown
        const all = els()
        // A swipe released past the threshold already has this ticket drawn and sliding in: just make it the front.
        const c = committed.current
        committed.current = null
        if (c && c.number === shown && all[c.idx]) {
          neighbour.current = null
          frontRef.current = c.idx
          setFront(c.idx)
          setDrawn(true)
          return
        }
        const oldIdx = frontRef.current
        const old = all[oldIdx]
        const sliding =
          animate &&
          !instantRef?.current &&
          old &&
          prev !== null &&
          prev !== shown &&
          !prefersReducedMotion() &&
          zoomRef.current <= 1 &&
          typeof old.animate === 'function' &&
          old.clientWidth > 0
        if (!sliding) settleAll()
        const idx = freeIdx()
        const back = all[idx]
        if (!back) return
        // Drawn before the slide starts, so the arriving ticket is never blank.
        releaseEl(back)
        renderTicket(back, image, placeholders, { number, name, phone })
        if (sliding && old) {
          const dir: 1 | -1 = shown > prev ? 1 : -1
          const w = old.clientWidth
          // A ticket that is itself still arriving carries on from where it is (no jump).
          const x0 = running.current.has(old) ? grab(old) : 0
          for (const [el, a] of running.current) {
            // Leaving tickets keep going; a reversal puts them away so they do not cross the new one.
            if (a && el !== old && Math.sign(offsetOf(el)) === dir) park(el, els().indexOf(el))
          }
          stripStyle(old, x0)
          stripStyle(back, neighbourAt(x0, dir, w))
          frontRef.current = idx
          setFront(idx)
          setDrawn(true)
          slide(
            [
              { el: old, from: x0, to: -dir * w },
              { el: back, from: neighbourAt(x0, dir, w), to: 0 },
            ],
            slideDuration(Math.abs(x0 + dir * w), w),
          )
          return
        }
        frontRef.current = idx
        setFront(idx)
        setDrawn(true)
      })
    })
    return () => {
      live = false
    }
    // `values` is derived from the primitives below; canvases are stable refs.
  }, [image, placeholders, number, name, phone, values === null])

  // Touch screens: a canvas has no native "Copy / Save" menu, so once the ticket has settled a real <img> of the
  // same picture lies over it and a long press works the way it does on any photo. Typing and swiping show the
  // canvas again (the image is dropped and drawn anew after a pause).
  const [coarse] = useState(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)
  const [nativeUrl, setNativeUrl] = useState<string | null>(null)
  const [regen, setRegen] = useState(0)
  useEffect(() => {
    setNativeUrl(null)
    if (!coarse || !image || !placeholders || !values || !drawn) return
    let live = true
    let url: string | null = null
    const id = setTimeout(() => {
      renderTicketBlob(image, placeholders, { number, name, phone })
        .then((blob) => {
          if (!live) return
          url = URL.createObjectURL(blob)
          setNativeUrl(url)
        })
        .catch(() => undefined)
    }, 350)
    return () => {
      live = false
      clearTimeout(id)
      if (url) URL.revokeObjectURL(url)
    }
    // `values` is derived from the primitives below.
  }, [coarse, image, placeholders, number, name, phone, drawn, regen, values === null])

  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const onPanStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (zoom <= 1 || e.pointerType === 'touch' || e.button !== 0) return
    pan.current = {
      x: e.clientX,
      y: e.clientY,
      left: e.currentTarget.scrollLeft,
      top: e.currentTarget.scrollTop,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPanMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pan.current
    if (!p) return
    e.currentTarget.scrollLeft = p.left - (e.clientX - p.x)
    e.currentTarget.scrollTop = p.top - (e.clientY - p.y)
  }
  const onPanEnd = () => {
    pan.current = null
  }

  const swipeOn = !!nav && !compact && zoom <= 1
  const commitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(commitTimer.current), [])

  /** Draws the neighbour towards `dir` (1 = next) for the strip; null when there is none to show. */
  const showNeighbour = (dir: 1 | -1): number | null => {
    const cur = neighbour.current
    if (cur?.dir === dir) return cur.idx
    if (cur) {
      const old = els()[cur.idx]
      if (old) hideEl(old)
      neighbour.current = null
    }
    const n = navRef.current
    const row = dir > 0 ? n?.nextRow : n?.prevRow
    const { image: img, placeholders: ph } = sourceRef.current
    if (!row || !img || !ph) return null
    const idx = freeIdx()
    const el = els()[idx]
    if (!el) return null
    renderTicket(el, img, ph, ticketValues(row))
    neighbour.current = { idx, dir, number: row.number }
    return idx
  }
  const swipeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!swipeOn || e.pointerType !== 'touch' || !e.isPrimary) return
    const el = els()[frontRef.current] ?? null
    if (!el || typeof el.animate !== 'function') return
    // A slide that is still running is caught where it is: the finger takes the picture from there (no jump),
    // and whatever was leaving is put away.
    const from = running.current.has(el) ? grab(el) : 0
    els().forEach((o, i) => {
      if (o && o !== el && (running.current.has(o) || o.style.transform)) park(o, i)
    })
    neighbour.current = null
    if (from) stripStyle(el, from)
    swipe.current = {
      px: e.clientX - from,
      py: e.clientY,
      from,
      axis: null,
      el,
      off: from,
      dx: from,
      samples: [{ t: e.timeStamp, x: e.clientX }],
    }
  }
  const swipeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = swipe.current
    if (!s?.el) return
    const dx = e.clientX - s.px
    if (s.axis === null) {
      s.axis = lockAxis(dx - s.from, e.clientY - s.py)
      if (s.axis === null) return
    }
    if (s.axis === 'y') {
      swipe.current = null
      if (s.from) settleStrip(s.el, s.from)
      return
    }
    setNativeUrl(null)
    s.dx = dx
    s.samples.push({ t: e.timeStamp, x: e.clientX })
    if (s.samples.length > 12) s.samples.shift()
    const n = navRef.current
    const off = follow(dx, !!n?.hasPrev, !!n?.hasNext)
    s.off = off
    // The strip follows the finger 1:1: the picture on screen and, right behind it, the neighbour in that direction.
    stripStyle(s.el, off)
    if (off !== 0) {
      const dir: 1 | -1 = off < 0 ? 1 : -1
      const idx = showNeighbour(dir)
      const ne = idx === null ? null : els()[idx]
      if (ne) stripStyle(ne, neighbourAt(off, dir, s.el.clientWidth))
    }
  }
  /** Eases the picture from `x` back to its place, and the neighbour (if one is shown) away again. */
  const settleStrip = (el: HTMLCanvasElement, x: number) => {
    const w = el.clientWidth
    const legs: Leg[] = []
    const nb = neighbour.current
    neighbour.current = null
    const ne = nb ? els()[nb.idx] : null
    if (prefersReducedMotion() || x === 0) {
      releaseEl(el)
      if (ne) hideEl(ne)
      return
    }
    legs.push({ el, from: x, to: 0 })
    if (nb && ne) legs.push({ el: ne, from: neighbourAt(x, nb.dir, w), to: nb.dir * w })
    slide(legs, slideDuration(Math.abs(x), w))
  }
  const swipeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = swipe.current
    swipe.current = null
    const el = s?.el
    if (!s || !el) return
    if (s.axis !== 'x') {
      if (s.from) settleStrip(el, s.from)
      return
    }
    const n = navRef.current
    const w = el.clientWidth
    const res =
      e.type === 'pointercancel'
        ? 'stay'
        : swipeResult({
            dx: s.dx,
            vx: velocity(s.samples),
            width: w,
            canPrev: !!n?.hasPrev,
            canNext: !!n?.hasNext,
          })
    if (res === 'stay' || !n) {
      settleStrip(el, s.off)
      return
    }
    const dir: 1 | -1 = res === 'next' ? 1 : -1
    const idx = showNeighbour(dir)
    const ne = idx === null ? null : els()[idx]
    const nb = neighbour.current
    if (idx === null || !ne || !nb) {
      settleStrip(el, s.off)
      return
    }
    if (prefersReducedMotion()) {
      // No travel: put everything away and let the plain swap (a short fade) show the new ticket.
      settleAll()
    } else {
      const x0 = s.off
      stripStyle(ne, neighbourAt(x0, dir, w))
      // The picture carries on out of the frame with the speed it was released at; the neighbour arrives behind it.
      const speed = Math.max(0, -dir * velocity(s.samples))
      committed.current = { idx, number: nb.number }
      neighbour.current = null
      slide(
        [
          { el, from: x0, to: -dir * w },
          { el: ne, from: neighbourAt(x0, dir, w), to: 0 },
        ],
        slideDuration(Math.abs(x0 + dir * w), w, speed),
      )
      clearTimeout(commitTimer.current)
      commitTimer.current = setTimeout(() => {
        // The new row never came (nothing to step to): take the neighbour as it is rather than leave a blank frame.
        const c = committed.current
        if (!c) return
        committed.current = null
        frontRef.current = c.idx
        setFront(c.idx)
      }, 800)
    }
    if (dir > 0) n.onNext()
    else n.onPrev()
  }

  if (!hasProjectImage) {
    return (
      <div className="tk-empty" role="status">
        <WsIcon name="image" size={36} />
        <p>{t('workspace.ticket.noImage')}</p>
        <p className="muted">
          {settingsTo ? t('workspace.ticket.noImageAdmin') : t('workspace.ticket.noImageHint')}
        </p>
        {settingsTo && (
          <AppLink to={settingsTo} className="btn btn-primary tk-empty-link">
            {t('workspace.ticket.openSettings')}
          </AppLink>
        )}
      </div>
    )
  }

  const empty = !participant
  const emptyKey = emptyReason === 'error' ? 'loadError' : emptyReason === 'no-rows' ? 'emptyProject' : null
  return (
    <div className="tk" data-compact={compact || undefined} data-nav={nav ? '' : undefined}>
      <div className="tk-bar" hidden={compact}>
        {nav && (
          <output className="tk-who" data-testid="ticket-who" aria-live="polite">
            {participant ? (
              <>
                <span className="tk-who-num">
                  {t('workspace.ticket.who', { number: participant.number })}
                </span>
                <span className="tk-who-name">{participant.name}</span>
              </>
            ) : (
              <span className="muted">{t('workspace.ticket.noRows')}</span>
            )}
          </output>
        )}
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would add default borders to a toolbar group */}
        <div className="tk-zoom" role="group" aria-label={t('workspace.zoom.label')}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('workspace.zoom.out')}
            disabled={zoom <= ZOOM_STEPS[0]}
            onClick={() => setZoom((z) => nextZoom(z, -1))}
          >
            <WsIcon name="zoomOut" size={18} />
          </Button>
          <button
            type="button"
            className="tk-zoom-value"
            title={t('workspace.zoom.reset')}
            aria-label={`${formatNumber(Math.round(zoom * 100))}%, ${t('workspace.zoom.reset')}`}
            onClick={() => setZoom(DEFAULT_ZOOM)}
          >
            {formatNumber(Math.round(zoom * 100))}%
          </button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('workspace.zoom.in')}
            disabled={zoom >= (ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 3)}
            onClick={() => setZoom((z) => nextZoom(z, 1))}
          >
            <WsIcon name="zoomIn" size={18} />
          </Button>
        </div>
      </div>

      {zoom > 1 && (
        <p className="tk-zoom-hint muted" role="status">
          {t('workspace.zoom.hint')}
        </p>
      )}
      <div
        className="tk-viewport"
        data-pan={zoom > 1 || undefined}
        data-swipe={swipeOn || undefined}
        onPointerDown={(e) => {
          onPanStart(e)
          swipeDown(e)
        }}
        onPointerMove={(e) => {
          onPanMove(e)
          swipeMove(e)
        }}
        onPointerUp={(e) => {
          onPanEnd()
          swipeUp(e)
        }}
        onPointerCancel={(e) => {
          onPanEnd()
          swipeUp(e)
        }}
      >
        <div
          className="tk-stage"
          data-morph={morph}
          data-ready={drawn || undefined}
          style={{ '--zoom': zoom, '--aspect': size ? size.w / size.h : 7 / 4 } as CSSProperties}
        >
          {Array.from({ length: POOL }, (_, i) => i).map((i) => (
            <canvas
              key={i}
              ref={canvases[i]}
              className="tk-canvas"
              data-front={front === i || undefined}
              role={front === i ? 'img' : undefined}
              aria-hidden={front === i ? undefined : true}
              aria-label={
                participant
                  ? t('workspace.ticket.alt', { number: participant.number, name: participant.name })
                  : undefined
              }
            />
          ))}
          {/* The canvas next to it carries the accessible name; this copy only exists for the long press. */}
          {nativeUrl && <img className="tk-native" src={nativeUrl} alt="" draggable={false} />}
          {(imageLoading || (!drawn && !empty)) && <div className="tk-loading skeleton" aria-hidden="true" />}
        </div>
        {empty && (
          <div className="tk-note" role="status">
            <p>{emptyKey ? t(`workspace.ticket.${emptyKey}`) : t('workspace.ticket.noRows')}</p>
            {emptyKey && (
              <p className="muted">
                {t(`workspace.ticket.${emptyKey}Hint` as 'workspace.ticket.emptyProjectHint')}
              </p>
            )}
            {emptyReason === 'error' && onRetry && (
              <Button size="sm" onClick={onRetry}>
                {t('action.retry')}
              </Button>
            )}
          </div>
        )}
      </div>
      {nav && (
        <>
          <Button
            className="tk-step"
            data-dir="prev"
            iconOnly
            aria-label={t('workspace.ticket.prev')}
            disabled={!nav.hasPrev}
            onClick={nav.onPrev}
          >
            <WsIcon name="chevronLeft" size={22} />
          </Button>
          <Button
            className="tk-step"
            data-dir="next"
            iconOnly
            aria-label={t('workspace.ticket.next')}
            disabled={!nav.hasNext}
            onClick={nav.onNext}
          >
            <WsIcon name="chevronRight" size={22} />
          </Button>
        </>
      )}
    </div>
  )
}
