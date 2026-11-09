import { Button } from '../../components/Button'
import { Menu, type MenuItem } from '../../components/Menu'
import { Tooltip } from '../../components/Tooltip'
import { useI18n } from '../../i18n'
import type { SaveMode } from './folderSave'
import { WsIcon } from './icons'

interface SaveButtonProps {
  /** How many tickets a click saves (the selection, or the current row). */
  count: number
  mode: SaveMode
  /** The browser can write into a folder (File System Access API). */
  folderSupported: boolean
  disabled: boolean
  disabledReason?: string
  onSave: () => void
  onSaveAs: (mode: SaveMode) => void
}

/** Split button: the main part saves with the remembered choice, the arrow offers ZIP or separate files. */
export function SaveButton({
  count,
  mode,
  folderSupported,
  disabled,
  disabledReason,
  onSave,
  onSaveAs,
}: SaveButtonProps) {
  const { t } = useI18n()
  const many = count > 1
  const label = many ? t('workspace.save.many', { count }) : t('workspace.save')
  const hint = !many
    ? label
    : mode === 'zip'
      ? t('workspace.save.hintZip', { count })
      : folderSupported
        ? t('workspace.save.hintFolder', { count })
        : t('workspace.save.hintFiles', { count })
  const badge = !many ? null : mode === 'zip' ? 'ZIP' : t('workspace.save.badgeFiles')

  const items: MenuItem[] = [
    {
      id: 'zip',
      label: t('workspace.save.asZip'),
      checked: mode === 'zip',
      onSelect: () => onSaveAs('zip'),
    },
    {
      id: 'folder',
      label: folderSupported ? t('workspace.save.toFolder') : t('workspace.save.toFiles'),
      checked: mode === 'folder',
      onSelect: () => onSaveAs('folder'),
    },
  ]

  return (
    <span className="ws-savegroup" data-many={many || undefined}>
      <Tooltip content={disabled && disabledReason ? disabledReason : hint} side="bottom">
        <Button className="ws-save" aria-label={label} disabled={disabled} onClick={onSave}>
          <WsIcon name="save" />
          <span className="ws-tool-text">{label}</span>
          {badge && (
            <span className="ws-badge" aria-hidden="true">
              {badge}
            </span>
          )}
        </Button>
      </Tooltip>
      {many && (
        <Menu
          label={t('workspace.save.options')}
          items={items}
          trigger={(props) => (
            <Button
              {...props}
              className="ws-save-more"
              iconOnly
              disabled={disabled}
              aria-label={t('workspace.save.options')}
            >
              <WsIcon name="chevronDown" size={16} />
            </Button>
          )}
        />
      )}
    </span>
  )
}
