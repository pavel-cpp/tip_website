import { Suspense } from 'react'
import { Outlet, useLocation } from 'react-router'
import { useI18n } from '../i18n'
import { cx } from '../lib/cx'
import { supportsViewTransitions } from '../lib/viewTransition'
import { Skeleton } from './Skeleton'
import { Topbar } from './Topbar'

/** App frame: persistent topbar plus the routed page. `minimal` hides user navigation (login). */
export function Shell({ minimal = false }: { minimal?: boolean }) {
  const { t } = useI18n()
  const { pathname } = useLocation()
  return (
    <>
      <Topbar minimal={minimal} />
      {/* Without View Transitions each page fades in on its own (140-220 ms fallback). */}
      <main id="main" key={pathname} className={cx('page', !supportsViewTransitions() && 'route-enter')}>
        <Suspense fallback={<RouteFallback label={t('state.loading')} />}>
          <Outlet />
        </Suspense>
      </main>
    </>
  )
}

function RouteFallback({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} style={{ display: 'grid', gap: 12, maxWidth: 480 }}>
      <Skeleton height={28} width="40%" />
      <Skeleton height={14} />
      <Skeleton height={14} width="80%" />
    </div>
  )
}
