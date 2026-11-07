import { type MessageKey, useI18n } from '../i18n'

/** Stand-in for screens that later streams implement. */
export function PagePlaceholder({ titleKey }: { titleKey: MessageKey }) {
  const { t } = useI18n()
  return (
    <>
      <h1 className="page-title">{t(titleKey)}</h1>
      <p className="muted">{t('page.placeholder')}</p>
    </>
  )
}
