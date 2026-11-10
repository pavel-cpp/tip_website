import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
import { AppLink } from '../../components/AppLink'
import { Button } from '../../components/Button'
import { useI18n } from '../../i18n'
import {
  imageSize,
  loadFonts,
  renderTicket,
  type TicketImage,
  type TicketPlaceholders,
} from '../../lib/ticket'
import type { Participant } from './api'
import { WsIcon } from './icons'
import { ticketValues } from './ticketActions'

export const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3] as const
const DEFAULT_ZOOM = 1

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
  /** Picture-only mode: arrows to the previous/next participant and a "number, name" indicator. */
  nav?: TicketNav
}

export interface TicketNav {
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
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
}: TicketPanelProps) {
  const { t, formatNumber } = useI18n()
  const canvases = [useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null)]
  const [front, setFront] = useState<0 | 1>(0)
  const [drawn, setDrawn] = useState(false)
  const frontRef = useRef<0 | 1>(0)
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)

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
        const back = canvases[frontRef.current === 0 ? 1 : 0]?.current
        if (!live || !back) return
        renderTicket(back, image, placeholders, { number, name, phone })
        frontRef.current = frontRef.current === 0 ? 1 : 0
        setFront(frontRef.current)
        setDrawn(true)
      })
    })
    return () => {
      live = false
    }
    // `values` is derived from the primitives below; canvases are stable refs.
  }, [image, placeholders, number, name, phone, values === null])

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
        onPointerDown={onPanStart}
        onPointerMove={onPanMove}
        onPointerUp={onPanEnd}
        onPointerCancel={onPanEnd}
      >
        <div
          className="tk-stage"
          data-ready={drawn || undefined}
          style={{ '--zoom': zoom, '--aspect': size ? size.w / size.h : 7 / 4 } as CSSProperties}
        >
          {[0, 1].map((i) => (
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
