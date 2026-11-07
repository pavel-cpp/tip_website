import { useNavigate } from 'react-router'
import { useI18n } from '../i18n'
import { AppLink } from './AppLink'
import { Avatar } from './Avatar'
import { Button } from './Button'
import { LanguageMenu } from './LanguageMenu'
import { Menu } from './Menu'
import { ThemeMenu } from './ThemeMenu'

// Placeholder identity until the auth stream provides the current user.
const GUEST = { displayName: 'TIP', color: '#6cb4ff' }

export function Topbar({ minimal = false }: { minimal?: boolean }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const go = (to: string) => () => void navigate(to, { viewTransition: true })

  return (
    <header className="topbar">
      <AppLink to="/" className="brand">
        {t('app.name')}
      </AppLink>
      <div className="spacer" />
      <LanguageMenu />
      <ThemeMenu />
      {!minimal && (
        <Menu
          label={t('nav.userMenu')}
          items={[
            { id: 'projects', label: t('nav.projects'), onSelect: go('/') },
            { id: 'profile', label: t('nav.profile'), icon: 'user', onSelect: go('/profile') },
            {
              id: 'users',
              label: t('nav.adminUsers'),
              icon: 'users',
              onSelect: go('/admin/users'),
              separatorBefore: true,
            },
            { id: 'roles', label: t('nav.adminRoles'), icon: 'lock', onSelect: go('/admin/roles') },
            { id: 'system', label: t('nav.adminSystem'), icon: 'settings', onSelect: go('/admin/system') },
            {
              id: 'design',
              label: t('nav.design'),
              icon: 'pencil',
              onSelect: go('/design'),
              separatorBefore: true,
            },
          ]}
          trigger={(props) => (
            <Button {...props} variant="ghost" iconOnly aria-label={t('nav.userMenu')}>
              <Avatar user={GUEST} size={28} />
            </Button>
          )}
        />
      )}
    </header>
  )
}
