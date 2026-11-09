import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { useI18n } from '../../i18n'
import { WsIcon } from './icons'

export interface BulkBarProps {
  /** Rows currently selected (and visible). */
  count: number
  canClear: boolean
  /** Print/copy/save are offered only when the user may print. */
  canPrint: boolean
  /** Why printing is unavailable regardless of the selection (for example, no picture yet). */
  printBlocked?: string
  /** Exactly one row is selected and the ticket image is ready, so copying makes sense. */
  copyReady: boolean
  /** The ticket image is ready, so tickets can be saved (several rows are saved as one ZIP). */
  saveReady: boolean
  onPrint: () => void
  onCopy: () => void
  onSave: () => void
  onClear: () => void
  onDone: () => void
}

/**
 * Bulk actions of selection mode on touch screens. It takes the place of the bottom toolbar (same slot,
 * same height), so it never covers the list: close and count, the primary "Copy (N)", then Save, Print and Clear as icon buttons.
 */
export function BulkBar(p: BulkBarProps) {
  const { t, formatNumber } = useI18n()
  const none = p.count === 0
  return (
    <div className="pc-bar" role="toolbar" aria-label={t('workspace.bulk.label')}>
      <Button
        variant="ghost"
        iconOnly
        aria-label={t('workspace.select.exit')}
        onClick={p.onDone}
        data-testid="select-done"
      >
        <Icon name="x" />
      </Button>
      <span className="pc-bar-count" role="status">
        <span aria-hidden="true">{formatNumber(p.count)}</span>
        <span className="sr-only">{t('workspace.selectedCount', { count: p.count })}</span>
      </span>
      {p.canPrint && (
        <>
          <Button variant="primary" className="ws-main" disabled={none || !p.copyReady} onClick={p.onCopy}>
            <WsIcon name="copy" />
            <span className="ws-main-text">
              {none ? t('workspace.copy') : t('workspace.bulk.copyMany', { count: p.count })}
            </span>
          </Button>
          <Button
            iconOnly
            disabled={none || !p.saveReady}
            aria-label={p.count > 1 ? t('workspace.bulk.saveMany', { count: p.count }) : t('workspace.save')}
            onClick={p.onSave}
          >
            <WsIcon name="save" />
          </Button>
          <Button
            iconOnly
            disabled={none || !!p.printBlocked}
            disabledReason={p.printBlocked}
            aria-label={none ? t('workspace.print') : t('workspace.print.withCount', { count: p.count })}
            onClick={p.onPrint}
          >
            <WsIcon name="print" />
          </Button>
        </>
      )}
      {p.canClear && (
        <Button
          iconOnly
          disabled={none}
          aria-label={t('workspace.bulk.clear', { count: p.count })}
          onClick={p.onClear}
        >
          <WsIcon name="eraser" />
        </Button>
      )}
    </div>
  )
}
