import { AppLink } from '../components/AppLink'
import { useI18n } from '../i18n'

export default function NotFound() {
  const { t } = useI18n()
  return (
    <>
      <h1 className="page-title">{t('page.notFound.title')}</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        {t('page.notFound.body')}
      </p>
      <AppLink to="/">{t('page.notFound.home')}</AppLink>
    </>
  )
}
