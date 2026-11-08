import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { useI18n } from '../../i18n'
import { WsIcon } from './icons'

export interface BulkBarProps {
  /** Rows currently selected (and visible). */
  count: number
  allSelected: boolean
  canDelete: boolean
  /** Print/copy/save are offered only when the user may print. */
  canPrint: boolean
  copyReady: boolean
  onPrint: () => void
  onCopy: () => void
  onSave: () => void
  onDelete: () => void
  onSelectAll: () => void
  onDone: () => void
}

/**
 * Bulk actions for selection mode on touch screens. It is positioned over the bottom of the list
 * (the list keeps a fixed bottom padding), so showing it never moves the rows the user is tapping.
 */
export function BulkBar(p: BulkBarProps) {
  const { t } = useI18n()
  const none = p.count === 0
  return (
    <div className="pc-bar" role="toolbar" aria-label={t('workspace.bulk.label')}>
      <div className="pc-bar-head">
        <Button variant="ghost" size="sm" onClick={p.onDone} data-testid="select-done">
          <Icon name="x" size={16} />
          {t('workspace.select.exit')}
        </Button>
        <span className="pc-bar-count" role="status">
          {t('workspace.selectedCount', { count: p.count })}
        </span>
        <Button variant="ghost" size="sm" disabled={p.allSelected} onClick={p.onSelectAll}>
          {t('workspace.select.all')}
        </Button>
      </div>
      <div className="pc-bar-actions">
        {p.canPrint && (
          <>
            <Button className="pc-bar-btn" disabled={none} onClick={p.onPrint}>
              <WsIcon name="print" size={20} />
              <span>{t('workspace.bulk.print')}</span>
            </Button>
            <Button className="pc-bar-btn" disabled={none || !p.copyReady} onClick={p.onCopy}>
              <WsIcon name="copy" size={20} />
              <span>{t('workspace.bulk.copy')}</span>
            </Button>
            <Button className="pc-bar-btn" disabled={none || !p.copyReady} onClick={p.onSave}>
              <WsIcon name="save" size={20} />
              <span>{t('workspace.bulk.save')}</span>
            </Button>
          </>
        )}
        {p.canDelete && (
          <Button className="pc-bar-btn" variant="danger" disabled={none} onClick={p.onDelete}>
            <Icon name="trash" size={20} />
            <span>{t('workspace.bulk.delete', { count: p.count })}</span>
          </Button>
        )}
      </div>
    </div>
  )
}
