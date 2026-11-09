import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { Menu, type MenuItem } from '../../components/Menu'
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
 * same height), so it never covers the list: close and count, the primary "Print (N)", clear and a menu.
 */
export function BulkBar(p: BulkBarProps) {
  const { t, formatNumber } = useI18n()
  const none = p.count === 0
  const items: MenuItem[] = []
  if (p.canPrint) {
    items.push(
      {
        id: 'copy',
        label: p.copyReady || p.count <= 1 ? t('workspace.copy') : t('workspace.bulk.copyOne'),
        disabled: !p.copyReady,
        onSelect: p.onCopy,
      },
      {
        id: 'save',
        label: p.count > 1 ? t('workspace.bulk.saveMany', { count: p.count }) : t('workspace.save'),
        disabled: none || !p.saveReady,
        onSelect: p.onSave,
      },
    )
  }
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
        <Button
          variant="primary"
          className="ws-main"
          disabled={none || !!p.printBlocked}
          disabledReason={p.printBlocked}
          onClick={p.onPrint}
        >
          <WsIcon name="print" />
          <span className="ws-main-text">
            {none ? t('workspace.print') : t('workspace.print.withCount', { count: p.count })}
          </span>
        </Button>
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
      {items.length > 0 && (
        <Menu
          label={t('workspace.more.label')}
          items={items}
          trigger={(props) => (
            <Button {...props} iconOnly aria-label={t('workspace.more')}>
              <WsIcon name="more" />
            </Button>
          )}
        />
      )}
    </div>
  )
}
