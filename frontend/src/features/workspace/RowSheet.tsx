import {
  type KeyboardEvent,
  type ReactNode,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { useI18n } from '../../i18n'
import { usePresence } from '../../lib/motion'
import type { Participant } from './api'
import { WsIcon } from './icons'
import { shownValues } from './ParticipantCards'
import type { FailedState, RowPatch } from './ParticipantRow'
import { isSuspiciousPhone } from './tableLogic'

export type SheetSaveResult = 'ok' | 'error' | 'closed'

/** A name is one line: pasted line breaks become single spaces. */
const oneLine = (v: string) => v.replace(/\s*[\r\n]+\s*/g, ' ')

export interface RowSheetProps {
  /** The row being edited; null closes the sheet. */
  row: Participant | null
  /** 1-based position among the visible rows and their count, for the pager. */
  position: number
  total: number
  canEdit: boolean
  canDelete: boolean
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
  /** Saves the changed fields. `closed` means the table already dismissed the sheet (conflict, lock). */
  onSave: (id: string, patch: RowPatch) => Promise<SheetSaveResult>
  onDelete: (id: string) => void
  onClose: () => void
  /** Ticket preview for the draft values. */
  preview?: (row: Participant) => ReactNode
  /** A failed save of this row: the sheet reopens with what the user typed instead of the server copy. */
  retained?: FailedState | null
}

const FOCUSABLE =
  'a[href], button:not([disabled]):not([aria-disabled="true"]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Bottom sheet that edits one row on phones. The shell stays mounted while the user pages between rows so
 * the open animation plays once; the form inside is keyed by row and starts from that row's values.
 */
export function RowSheet(props: RowSheetProps) {
  const { row, onClose } = props
  const { mounted, state } = usePresence(row !== null)
  // Keep the last row on screen while the exit animation plays.
  const lastRow = useRef(row)
  if (row) lastRow.current = row
  const shown = row ?? lastRow.current
  const open = row !== null

  const shell = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Esc is handled by the keydown below; the back gesture closes through one history entry.
  useEffect(() => {
    if (!open) return
    const pushed = { current: true }
    window.history.pushState({ ...window.history.state, tipSheet: true }, '')
    const onPop = () => {
      if (!pushed.current) return
      pushed.current = false
      onCloseRef.current()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      if (pushed.current) window.history.back()
    }
  }, [open])

  // Keep the sheet above the on-screen keyboard: iOS shrinks only the visual viewport.
  useEffect(() => {
    if (!open) return
    const vv = window.visualViewport
    const el = shell.current
    if (!vv || !el) return
    const apply = () => {
      el.style.setProperty('--sheet-kb', `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`)
      el.style.setProperty('--sheet-vh', `${vv.height}px`)
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
    }
  }, [open, mounted])

  // The page behind is inert while the sheet is open, and focus returns to the card afterwards.
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    shell.current?.querySelector<HTMLElement>('.sheet-input')?.focus({ preventScroll: true })
    return () => {
      root?.removeAttribute('inert')
      previous?.focus?.({ preventScroll: true })
    }
  }, [open])

  if (!mounted || !shown) return null

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab' || !shell.current) return
    const items = [...shell.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop press and Esc/Tab handling are the sheet's own behaviour
    <div ref={shell} className="sheet-overlay" data-state={state} role="presentation" onKeyDown={onKeyDown}>
      <div className="sheet-backdrop" aria-hidden="true" onPointerDown={onClose} />
      <SheetForm {...props} row={shown} />
    </div>,
    document.body,
  )
}

function SheetForm({
  row,
  position,
  total,
  canEdit,
  canDelete,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onSave,
  onDelete,
  onClose,
  preview,
  retained,
}: RowSheetProps & { row: Participant }) {
  const { t } = useI18n()
  const titleId = useId()
  const [name, setName] = useState(() => shownValues(row, retained).name)
  const [phone, setPhone] = useState(() => shownValues(row, retained).phone)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const phoneRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLTextAreaElement>(null)

  // The name field grows with its text so a long name is always fully visible.
  useLayoutEffect(() => {
    const el = nameRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [name])

  // A colleague's change arrives while nothing is typed yet: show it instead of the stale values.
  const base = useRef({ id: row.id, name: row.name, phone: row.phone })
  useLayoutEffect(() => {
    const b = base.current
    if (b.id !== row.id) {
      // Paging to another row starts from that row's values (or its retained failed edit).
      const v = shownValues(row, retained)
      setName(v.name)
      setPhone(v.phone)
      setFailed(false)
    } else if (name === b.name && phone === b.phone) {
      setName(row.name)
      setPhone(row.phone)
    }
    base.current = { id: row.id, name: row.name, phone: row.phone }
    // Only a new row or a new server copy of it resets the draft.
  }, [row.id, row.name, row.phone, row.version])

  const patch: RowPatch = {}
  if (name !== row.name) patch.name = name
  if (phone !== row.phone) patch.phone = phone
  const dirty = Object.keys(patch).length > 0
  const suspicious = isSuspiciousPhone(phone)
  const draft = useDeferredValue({ ...row, name, phone })

  const save = async () => {
    if (!canEdit || busy) return
    if (!dirty) {
      onClose()
      return
    }
    setBusy(true)
    setFailed(false)
    const res = await onSave(row.id, patch)
    setBusy(false)
    if (res === 'ok') onClose()
    else if (res === 'error') setFailed(true)
  }

  // Paging keeps what was typed: the change is sent in the background and the next row opens at once.
  const go = (fn: () => void) => {
    if (canEdit && dirty) void onSave(row.id, patch)
    fn()
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="sheet-grab" aria-hidden="true" />
      <header className="sheet-head">
        <div className="sheet-heading">
          <h2 id={titleId} className="sheet-title">
            {t('workspace.sheet.title', { number: row.number })}
          </h2>
          <span className="sheet-pos muted">{t('workspace.sheet.position', { index: position, total })}</span>
        </div>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('workspace.sheet.prev')}
          disabled={!hasPrev}
          onClick={() => go(onPrev)}
        >
          <WsIcon name="chevronUp" />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('workspace.sheet.next')}
          disabled={!hasNext}
          onClick={() => go(onNext)}
        >
          <WsIcon name="chevronDown" />
        </Button>
        <Button variant="ghost" iconOnly aria-label={t('workspace.sheet.close')} onClick={onClose}>
          <Icon name="x" />
        </Button>
      </header>

      <div className="sheet-body">
        <div className="sheet-form">
          <label className="field">
            <span className="field-label">{t('workspace.col.name')}</span>
            <textarea
              ref={nameRef}
              className="sheet-input sheet-name"
              name="participant-name"
              rows={1}
              value={name}
              readOnly={!canEdit}
              maxLength={200}
              autoComplete="off"
              enterKeyHint="next"
              onChange={(e) => setName(oneLine(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  phoneRef.current?.focus()
                }
              }}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('workspace.col.phone')}</span>
            <input
              ref={phoneRef}
              className="sheet-input sheet-phone"
              name="participant-phone"
              value={phone}
              readOnly={!canEdit}
              maxLength={200}
              inputMode="tel"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="done"
              aria-invalid={suspicious || undefined}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void save()
                }
              }}
            />
            {suspicious && (
              <span className="field-error sheet-warn">
                <Icon name="alert" size={16} />
                {t('workspace.phone.suspicious')}
              </span>
            )}
          </label>
          {failed && (
            <p className="field-error" role="alert">
              {t('workspace.sheet.saveFailed')}
            </p>
          )}
        </div>

        {preview && (
          <section className="sheet-preview" aria-label={t('workspace.sheet.preview')}>
            {preview(draft)}
          </section>
        )}
      </div>

      <footer className="sheet-foot">
        {canDelete && (
          <Button
            variant="danger"
            onClick={() => {
              onDelete(row.id)
              onClose()
            }}
          >
            <Icon name="trash" size={18} />
            {t('workspace.sheet.delete')}
          </Button>
        )}
        <span className="spacer" />
        {canEdit && (
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {t('workspace.sheet.save')}
          </Button>
        )}
      </footer>
    </div>
  )
}
