import { Button } from '../../components/Button'
import { Menu, type MenuItem } from '../../components/Menu'
import { useI18n } from '../../i18n'
import { WsIcon } from './icons'

export interface PhoneToolbarProps {
  canPrint: boolean
  copyLabel: string
  saveLabel: string
  /** Why copying and saving are unavailable right now (nothing selected yet), shown as the tooltip. */
  disabledReason?: string
  /** Print, import, export and settings live in the menu, so the two main actions keep their size. */
  items: MenuItem[]
  onCopy: () => void
  onSave: () => void
}

/** Bottom bar on phones: primary "Copy", then Save and one "more" menu, always the same layout. */
export function PhoneToolbar({
  canPrint,
  copyLabel,
  saveLabel,
  disabledReason,
  items,
  onCopy,
  onSave,
}: PhoneToolbarProps) {
  const { t } = useI18n()
  return (
    <div className="ws-toolbar ws-toolbar-phone" role="toolbar" aria-label={t('workspace.toolbar')}>
      {canPrint && (
        <>
          <Button
            variant="primary"
            className="ws-main"
            disabled={!!disabledReason}
            disabledReason={disabledReason}
            onClick={onCopy}
          >
            <WsIcon name="copy" />
            <span className="ws-main-text">{copyLabel}</span>
          </Button>
          <Button
            className="ws-save-phone"
            iconOnly
            aria-label={saveLabel}
            disabled={!!disabledReason}
            disabledReason={disabledReason}
            onClick={onSave}
          >
            <WsIcon name="save" />
          </Button>
        </>
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
