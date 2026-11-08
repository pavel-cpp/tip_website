import { LOCALES, useI18n } from '../i18n'
import { Button } from './Button'
import { Icon } from './Icon'
import { Menu } from './Menu'

export function LanguageMenu() {
  const { t, locale, setLocale } = useI18n()
  return (
    <Menu
      label={t('language.title')}
      items={LOCALES.map((l) => ({
        id: l,
        label: t(`language.${l}`),
        checked: l === locale,
        onSelect: () => void setLocale(l),
      }))}
      trigger={(props) => (
        <Button {...props} variant="ghost" aria-label={`${locale.toUpperCase()}, ${t('language.title')}`}>
          <Icon name="globe" />
          {locale.toUpperCase()}
        </Button>
      )}
    />
  )
}
