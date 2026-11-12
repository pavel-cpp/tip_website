// biome-ignore-all lint/a11y/useSemanticElements: virtualized spreadsheet grid needs the ARIA grid pattern, not <table>
// biome-ignore-all lint/a11y/useFocusableInteractive: focus is managed on the grid via aria-activedescendant
// biome-ignore-all lint/a11y/useAriaPropsSupportedByRole: row/cell state attributes follow the ARIA grid pattern
import { type CSSProperties, memo, useRef } from 'react'
import { UserAvatar } from '../../auth/UserAvatar'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { useI18n } from '../../i18n'
import type { Participant } from './api'
import { CursorStrip } from './CursorStrip'
import { WsIcon } from './icons'
import type { RowCursor, RowLockOwner } from './presence'
import { COLUMNS, type Column } from './tableLogic'

export const ROW_HEIGHT = 44

export interface EditState {
  id: string
  col: number
  value: string
  original: string
}

/** Fields a save sends; the sheet may change both at once. */
export interface RowPatch {
  name?: string
  phone?: string
}

export interface ConflictState {
  field: 'name' | 'phone'
  mine: string
  current: Participant
  /** The whole patch to resend on "keep mine" (set when several fields were saved together). */
  patch?: RowPatch
}

/** A cell whose save failed: the typed value stays on screen until the user retries or edits it. */
export interface FailedState {
  col: number
  value: string
  /** Set when the sheet saved several fields at once; retry resends all of them. */
  patch?: RowPatch
}

export interface RowHandlers {
  onRetry: (id: string) => void
  onEditChange: (value: string) => void
  onEditPaste: (text: string) => boolean
  onResolveTheirs: (id: string) => void
  onResolveMine: (id: string) => void
}

export interface ParticipantRowProps {
  row: Participant
  index: number
  top: number
  selected: boolean
  current: boolean
  activeCol: number | null
  editing: EditState | null
  /** Someone else is editing this row: it renders non-editable with an outline in their colour. */
  lockedBy?: RowLockOwner | null
  /** Colleagues who are only looking at this row. */
  cursors?: readonly RowCursor[]
  leaving: boolean
  fresh: boolean
  freshColor: string
  /** Incremented to replay the "you cannot edit this" shake. */
  shake: number
  tipOpen: boolean
  conflict: ConflictState | null
  failed?: FailedState | null
  /** An edit of this row is still waiting to be sent while the connection is down. */
  unsent?: boolean
  rowCount: number
  handlers: RowHandlers
}

const HEAD_KEY: Record<Column, 'workspace.col.number' | 'workspace.col.name' | 'workspace.col.phone'> = {
  number: 'workspace.col.number',
  name: 'workspace.col.name',
  phone: 'workspace.col.phone',
}

export const cellId = (rowId: string, col: number) => `cell-${rowId}-${col}`

function ParticipantRowImpl({
  row,
  index,
  top,
  selected,
  current,
  activeCol,
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
  rowCount,
  handlers,
}: ParticipantRowProps) {
  const { t } = useI18n()
  // Keep the last owner while the outline fades out so it does not flash to the default colour.
  const owner = lockedBy
  const lastOwner = useRef(lockedBy)
  if (lockedBy) lastOwner.current = lockedBy
  const style = {
    transform: `translateY(${top}px)`,
    height: ROW_HEIGHT,
    '--lock': (owner ?? lastOwner.current)?.color,
    '--fresh': freshColor,
    zIndex: conflict ? 3 : undefined,
  } as CSSProperties

  return (
    <div
      role="row"
      className="pt-row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      aria-readonly={owner ? true : undefined}
      data-row-id={row.id}
      data-selected={selected || undefined}
      data-current={current || undefined}
      data-locked={owner ? 'true' : undefined}
      data-leaving={leaving || undefined}
      data-fresh={fresh || undefined}
      data-conflict={conflict ? 'true' : undefined}
      data-unsent={unsent || undefined}
      data-tip={tipOpen || undefined}
      data-last={index === rowCount - 1 || undefined}
      style={style}
    >
      <div className="pt-row-inner">
        {fresh && <span className="pt-fresh" aria-hidden="true" />}
        <span key={shake} className="pt-lock-ring" data-shake={shake > 0 || undefined} aria-hidden="true" />
        <CursorStrip cursors={cursors} />
        {COLUMNS.map((c, col) => {
          const isEditing = editing?.id === row.id && editing.col === col
          const isFailed = failed?.col === col
          const value = isFailed && failed ? failed.value : c === 'number' ? String(row.number) : row[c]
          return (
            <div
              key={c}
              role="gridcell"
              id={cellId(row.id, col)}
              className="pt-cell"
              data-cell
              data-row={index}
              data-col={col}
              data-col-name={c}
              data-active={activeCol === col || undefined}
              data-editing={isEditing || undefined}
              data-failed={isFailed || undefined}
              aria-readonly={c === 'number' || owner ? true : undefined}
            >
              {isEditing && editing ? (
                <input
                  className="pt-input"
                  // Autofocus is the point: the cell was just put into edit mode by the user.
                  // biome-ignore lint/a11y/noAutofocus: focus follows the user's explicit edit action
                  autoFocus
                  aria-label={t(HEAD_KEY[c])}
                  value={editing.value}
                  inputMode={c === 'phone' ? 'tel' : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={200}
                  onChange={(e) => handlers.onEditChange(e.target.value)}
                  onFocus={(e) =>
                    e.currentTarget.setSelectionRange(
                      e.currentTarget.value.length,
                      e.currentTarget.value.length,
                    )
                  }
                  onPaste={(e) => {
                    if (handlers.onEditPaste(e.clipboardData.getData('text/plain'))) e.preventDefault()
                  }}
                />
              ) : (
                <>
                  <span className="pt-text" data-mono={c !== 'name' || undefined}>
                    {value}
                  </span>
                  {c === 'number' && unsent && !failed && (
                    // Beside the number (not over the cells) so it never hides the name or the phone.
                    <span
                      className="pt-unsent"
                      role="img"
                      aria-label={t('workspace.row.unsent')}
                      title={`${t('workspace.row.unsent')}: ${t('workspace.row.unsentTitle')}`}
                    >
                      <WsIcon name="clock" size={14} />
                    </span>
                  )}
                  {isFailed && (
                    <button
                      type="button"
                      className="pt-retry"
                      aria-label={t('workspace.row.retryLabel', { number: row.number })}
                      onClick={(e) => {
                        e.stopPropagation()
                        handlers.onRetry(row.id)
                      }}
                    >
                      <Icon name="alert" size={14} />
                      {t('workspace.row.failed')} · {t('workspace.row.retry')}
                    </button>
                  )}
                </>
              )}
            </div>
          )
        })}
        {owner && (
          <span className="pt-lock-tip" role="status">
            <UserAvatar user={owner} size={18} />
            {t('workspace.editing', { name: owner.displayName })}
          </span>
        )}
      </div>
      {conflict && (
        <div className="pt-conflict" role="alert">
          <p>
            {t('workspace.conflict.text', {
              field: t(HEAD_KEY[conflict.field]),
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

export const ParticipantRow = memo(ParticipantRowImpl)
