import { useI18n } from '../i18n'
import { THEME_MODES, type ThemeMode, useTheme } from '../theme/theme'
import { Button } from './Button'
import type { IconName } from './Icon'
import { Icon } from './Icon'
import { Menu } from './Menu'

const MODE_ICON: Record<ThemeMode, IconName> = { dark: 'moon', light: 'sun', system: 'monitor' }

export function ThemeMenu() {
  const { t } = useI18n()
  const { mode, setMode } = useTheme()
  return (
    <Menu
      label={t('theme.title')}
      items={THEME_MODES.map((m) => ({
        id: m,
        label: t(`theme.${m}`),
        icon: MODE_ICON[m],
        checked: m === mode,
        onSelect: () => setMode(m),
      }))}
      trigger={(props) => (
        <Button {...props} variant="ghost" iconOnly aria-label={t('theme.title')}>
          <Icon name={MODE_ICON[mode]} />
        </Button>
      )}
    />
  )
}
