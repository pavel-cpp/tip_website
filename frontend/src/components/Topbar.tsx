import { useNavigate } from 'react-router'
import { useOptionalAuth } from '../auth/AuthProvider'
import { UserAvatar } from '../auth/UserAvatar'
import { useI18n } from '../i18n'
import { AppLink } from './AppLink'
import { Button } from './Button'
import { LanguageMenu } from './LanguageMenu'
import { Menu, type MenuItem } from './Menu'
import { ThemeMenu } from './ThemeMenu'

export function Topbar({ minimal = false }: { minimal?: boolean }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const auth = useOptionalAuth()
  const user = auth?.user ?? null
  const go = (to: string) => () => void navigate(to, { viewTransition: true })
  const can = (perm: string) => user?.permissions.includes(perm as never) ?? false

  // Items without the permission are left out entirely (no permission, no element).
  const items: MenuItem[] = user
    ? [
        { id: 'projects', label: t('nav.projects'), onSelect: go('/') },
        { id: 'profile', label: t('nav.profile'), icon: 'user', onSelect: go('/profile') },
        ...(can('user.view')
          ? [
              {
                id: 'users',
                label: t('nav.adminUsers'),
                icon: 'users' as const,
                onSelect: go('/admin/users'),
                separatorBefore: true,
              },
            ]
          : []),
        ...(can('role.manage')
          ? [{ id: 'roles', label: t('nav.adminRoles'), icon: 'lock' as const, onSelect: go('/admin/roles') }]
          : []),
        ...(can('system.view')
          ? [
              {
                id: 'system',
                label: t('nav.adminSystem'),
                icon: 'settings' as const,
                onSelect: go('/admin/system'),
              },
            ]
          : []),
        {
          id: 'design',
          label: t('nav.design'),
          icon: 'pencil',
          onSelect: go('/design'),
          separatorBefore: true,
        },
        {
          id: 'logout',
          label: t('action.signOut'),
          icon: 'logout',
          onSelect: () => void auth?.logout(),
        },
      ]
    : []

  return (
    <header className="topbar">
      <AppLink to="/" className="brand">
        {t('app.name')}
      </AppLink>
      <div className="spacer" />
      <LanguageMenu />
      <ThemeMenu />
      {!minimal && user && (
        <Menu
          label={t('nav.userMenu')}
          items={items}
          trigger={(props) => (
            <Button {...props} variant="ghost" iconOnly aria-label={t('nav.userMenu')}>
              <UserAvatar user={user} size={28} />
            </Button>
          )}
        />
      )}
    </header>
  )
}
