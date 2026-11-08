import { Button } from '../../components/Button'
import { Menu, type MenuItem } from '../../components/Menu'
import { useI18n } from '../../i18n'
import { WsIcon } from './icons'

export interface PhoneToolbarProps {
  canPrint: boolean
  printLabel: string
  /** Why printing is unavailable right now (nothing selected yet), shown as the tooltip. */
  printDisabled?: string
  /** Secondary actions live in the menu so the primary one keeps its full label. */
  items: MenuItem[]
  onPrint: () => void
}

/** Bottom bar on phones: the primary "Print (N)" button and one "more" menu, always the same layout. */
export function PhoneToolbar({ canPrint, printLabel, printDisabled, items, onPrint }: PhoneToolbarProps) {
  const { t } = useI18n()
  return (
    <div className="ws-toolbar ws-toolbar-phone" role="toolbar" aria-label={t('workspace.toolbar')}>
      {canPrint && (
        <Button
          variant="primary"
          className="ws-main"
          disabled={!!printDisabled}
          disabledReason={printDisabled}
          onClick={onPrint}
        >
          <WsIcon name="print" />
          <span className="ws-main-text">{printLabel}</span>
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
