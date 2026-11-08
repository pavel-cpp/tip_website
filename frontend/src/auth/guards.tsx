import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { Button } from '../components/Button'
import { Skeleton } from '../components/Skeleton'
import { useI18n } from '../i18n'
import { useAuth } from './AuthProvider'
import type { PermissionCode } from './types'

/** Permission check against the user's claims; the server remains the authority. */
export function useCan(perm: PermissionCode): boolean {
  const { user } = useAuth()
  return user?.permissions.includes(perm) ?? false
}

/** Renders its children only with the permission (no permission, no element: no noise). */
export function Can({
  perm,
  children,
  fallback = null,
}: {
  perm: PermissionCode
  children: ReactNode
  fallback?: ReactNode
}) {
  return useCan(perm) ? children : fallback
}

function SessionLoading() {
  const { t } = useI18n()
  return (
    <div role="status" aria-label={t('state.loading')} style={{ display: 'grid', gap: 12, padding: 24 }}>
      <Skeleton height={28} width="30%" />
      <Skeleton height={14} />
      <Skeleton height={14} width="70%" />
    </div>
  )
}

function SessionUnavailable() {
  const { t } = useI18n()
  const { retry } = useAuth()
  return (
    <div className="page" role="alert" style={{ display: 'grid', gap: 12, justifyItems: 'start' }}>
      <h1 className="page-title">{t('errors.NETWORK')}</h1>
      <Button variant="primary" onClick={retry}>
        {t('action.retry')}
      </Button>
    </div>
  )
}

export function Forbidden() {
  const { t } = useI18n()
  return (
    <div role="alert">
      <h1 className="page-title">{t('auth.forbidden.title')}</h1>
      <p className="muted">{t('auth.forbidden.body')}</p>
    </div>
  )
}

/** Layout route: signed-out visitors are sent to /login and come back afterwards. */
export function RequireAuth() {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <SessionLoading />
  if (status === 'unavailable') return <SessionUnavailable />
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <Outlet />
}

/** Layout route for permission-gated screens; a signed-in user without the permission sees "no access". */
export function RequirePerm({ perm }: { perm: PermissionCode }) {
  const allowed = useCan(perm)
  return allowed ? <Outlet /> : <Forbidden />
}
