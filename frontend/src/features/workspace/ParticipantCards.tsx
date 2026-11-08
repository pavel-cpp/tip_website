// biome-ignore-all lint/a11y/useSemanticElements: virtualized absolutely positioned items cannot be <li> inside the measured wrapper
import { type CSSProperties, memo, useRef } from 'react'
import { UserAvatar } from '../../auth/UserAvatar'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { useI18n } from '../../i18n'
import type { Participant } from './api'
import type { ConflictState, FailedState } from './ParticipantRow'
import type { RowCursor, RowLockOwner } from './presence'
import { isSuspiciousPhone } from './tableLogic'

/** First-paint height guess for a card (number + one name line + phone + gap); real heights are measured. */
export const CARD_ESTIMATE = 84
const LONG_PRESS_MS = 450
const MOVE_SLOP = 10

export interface CardHandlers {
  onOpen: (id: string) => void
  onToggle: (id: string) => void
  onLongPress: (id: string) => void
  onRetry: (id: string) => void
  onResolveTheirs: (id: string) => void
  onResolveMine: (id: string) => void
}

export interface ParticipantCardProps {
  row: Participant
  index: number
  top: number
  measure: (el: HTMLElement | null) => void
  selected: boolean
  selectMode: boolean
  current: boolean
  /** The bottom sheet is editing this row right now (the row is locked for colleagues). */
  editing: boolean
  lockedBy?: RowLockOwner | null
  cursors?: readonly RowCursor[]
  leaving: boolean
  fresh: boolean
  freshColor: string
  shake: number
  tipOpen: boolean
  conflict: ConflictState | null
  failed?: FailedState | null
  unsent?: boolean
  handlers: CardHandlers
}

/** What the card shows while a save is failed: the typed values, not the server's. */
export function shownValues(row: Participant, failed: FailedState | null | undefined) {
  if (!failed) return { name: row.name, phone: row.phone }
  const p = failed.patch
  return {
    name: p?.name ?? (failed.col === 1 ? failed.value : row.name),
    phone: p?.phone ?? (failed.col === 2 ? failed.value : row.phone),
  }
}

function ParticipantCardImpl({
  row,
  index,
  top,
  measure,
  selected,
  selectMode,
  current,
  editing,
  lockedBy = null,
  cursors = [],
  leaving,
  fresh,
  freshColor,
  shake,
  tipOpen,
  conflict,
  failed = null,
  unsent = false,
  handlers,
}: ParticipantCardProps) {
  const { t } = useI18n()
  const lastOwner = useRef(lockedBy)
  if (lockedBy) lastOwner.current = lockedBy
  const { name, phone } = shownValues(row, failed)
  const suspicious = !failed && isSuspiciousPhone(row.phone)
  // One readable sentence for screen readers instead of the glued "5Name+998..." of the child spans.
  const label = [
    t('workspace.card.label', {
      number: row.number,
      name: name || t('workspace.card.noName'),
      phone: phone || t('workspace.card.noPhone'),
    }),
    suspicious && t('workspace.card.state.suspicious'),
    failed && t('workspace.card.state.failed'),
    unsent && !failed && t('workspace.card.state.unsent'),
    lockedBy && t('workspace.card.state.locked', { name: lockedBy.displayName }),
  ]
    .filter(Boolean)
    .join(', ')

  // Long press enters selection mode; a press that moves is a scroll and never fires.
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const longFired = useRef(false)
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }

  const style = {
    transform: `translateY(${top}px)`,
    '--lock': (lockedBy ?? lastOwner.current)?.color,
    '--fresh': freshColor,
  } as CSSProperties

  return (
    <div
      ref={measure}
      role="listitem"
      className="pc-item"
      data-index={index}
      data-row-id={row.id}
      data-selected={selected || undefined}
      data-current={current || undefined}
      data-locked={lockedBy ? 'true' : undefined}
      data-editing={editing || undefined}
      data-leaving={leaving || undefined}
      data-fresh={fresh || undefined}
      data-conflict={conflict ? 'true' : undefined}
      data-unsent={unsent || undefined}
      data-failed={failed ? 'true' : undefined}
      data-tip={tipOpen || undefined}
      style={style}
    >
      <div className="pc-card">
        {fresh && <span className="pt-fresh" aria-hidden="true" />}
        <span key={shake} className="pt-lock-ring" data-shake={shake > 0 || undefined} aria-hidden="true" />
        {cursors.length > 0 && (
          <span className="pt-cursors" aria-hidden="true">
            {cursors.map((c) => (
              <span key={c.id} className="pt-cursor" style={{ background: c.color }} title={c.displayName} />
            ))}
          </span>
        )}
        {selectMode && (
          <label className="pc-check">
            <input
              type="checkbox"
              checked={selected}
              aria-label={t('workspace.card.toggle', { number: row.number })}
              onChange={() => handlers.onToggle(row.id)}
            />
          </label>
        )}
        <button
          type="button"
          className="pc-main"
          aria-label={label}
          aria-haspopup={selectMode ? undefined : 'dialog'}
          aria-pressed={selectMode ? selected : undefined}
          onPointerDown={(e) => {
            longFired.current = false
            cancelPress()
            press.current = {
              x: e.clientX,
              y: e.clientY,
              timer: setTimeout(() => {
                press.current = null
                longFired.current = true
                handlers.onLongPress(row.id)
              }, LONG_PRESS_MS),
            }
          }}
          onPointerMove={(e) => {
            const p = press.current
            if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_SLOP) cancelPress()
          }}
          onPointerUp={cancelPress}
          onPointerCancel={cancelPress}
          onPointerLeave={cancelPress}
          onContextMenu={(e) => e.preventDefault()}
          onClick={() => {
            if (longFired.current) {
              longFired.current = false
              return
            }
            if (selectMode) handlers.onToggle(row.id)
            else handlers.onOpen(row.id)
          }}
        >
          {/* In selection mode the checkbox takes the number's place, so names keep their width. */}
          {!selectMode && <span className="pc-num">{row.number}</span>}
          {/* Plain spaces between the spans keep the visible text equal to the accessible name (WCAG 2.5.3). */}{' '}
          <span className="pc-body">
            <span className="pc-name" data-empty={name === '' || undefined}>
              {name || t('workspace.conflict.empty')}
            </span>{' '}
            <span className="pc-phone" data-suspicious={suspicious || undefined}>
              {phone || t('workspace.conflict.empty')}
              {suspicious && (
                <span className="pt-warn" title={t('workspace.phone.suspicious')}>
                  <Icon name="alert" size={16} />
                  <span className="sr-only">{t('workspace.phone.suspicious')}</span>
                </span>
              )}
            </span>
          </span>
        </button>
        {(failed || (unsent && !failed)) && (
          <div className="pc-status">
            {failed && (
              <button
                type="button"
                className="pt-retry pc-retry"
                aria-label={t('workspace.row.retryLabel', { number: row.number })}
                onClick={() => handlers.onRetry(row.id)}
              >
                <Icon name="alert" size={14} />
                {t('workspace.row.failed')} · {t('workspace.row.retry')}
              </button>
            )}
            {unsent && !failed && (
              <span className="pc-unsent" title={t('workspace.row.unsentTitle')}>
                {t('workspace.row.unsent')}
              </span>
            )}
          </div>
        )}
        {lockedBy && (
          <span className="pt-lock-tip pc-lock-tip" role="status">
            <UserAvatar user={lockedBy} size={18} />
            {t('workspace.editing', { name: lockedBy.displayName })}
          </span>
        )}
      </div>
      {conflict && (
        <div className="pc-conflict" role="alert">
          <p>
            {t('workspace.conflict.text', {
              field: t(conflict.field === 'name' ? 'workspace.col.name' : 'workspace.col.phone'),
              theirs: conflict.current[conflict.field] || t('workspace.conflict.empty'),
              mine: conflict.mine || t('workspace.conflict.empty'),
            })}
          </p>
          <div className="pt-conflict-actions">
            <Button size="sm" variant="ghost" onClick={() => handlers.onResolveTheirs(row.id)}>
              {t('workspace.conflict.theirs')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => handlers.onResolveMine(row.id)}>
              {t('workspace.conflict.mine')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export const ParticipantCard = memo(ParticipantCardImpl)
