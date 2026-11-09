import { Suspense, useEffect, useRef } from 'react'
import { Outlet, useLocation } from 'react-router'
import { useI18n } from '../i18n'
import { cx } from '../lib/cx'
import { supportsViewTransitions } from '../lib/viewTransition'
import { Skeleton } from './Skeleton'
import { Topbar } from './Topbar'
import { TopbarSlotProvider } from './TopbarSlot'

/**
 * Keeps document.title equal to the page heading (WCAG 2.4.2). Pages render exactly one h1; reading it
 * here avoids threading a title through every route, and the observer picks up headings that arrive
 * after data loads (a project name) or after a language switch. `pathname` re-binds the observer
 * because the main element is re-created on every navigation.
 */
function useHeadingTitle(main: React.RefObject<HTMLElement | null>, appName: string, pathname: string): void {
  useEffect(() => {
    const el = main.current
    if (!el) return
    const sync = () => {
      const h1 = el.querySelector('h1')?.textContent?.trim()
      document.title = h1 ? `${h1} · ${appName}` : appName
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [main, appName, pathname])
}

/** App frame: persistent topbar plus the routed page. `minimal` hides user navigation (login). */
export function Shell({ minimal = false }: { minimal?: boolean }) {
  const { t } = useI18n()
  const { pathname } = useLocation()
  const main = useRef<HTMLElement>(null)
  const first = useRef(true)
  useHeadingTitle(main, t('app.name'), pathname)

  // After a client-side navigation keyboard and screen-reader users start at the new page, not at the
  // link they activated (which has just been unmounted).
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    main.current?.focus({ preventScroll: true })
  }, [pathname])

  return (
    <>
      {/* biome-ignore lint/a11y/useValidAnchor: a same-page skip link whose click moves focus to main */}
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault()
          main.current?.focus()
        }}
      >
        {t('a11y.skipToContent')}
      </a>
      <TopbarSlotProvider>
        <Topbar minimal={minimal} />
        {/* Without View Transitions each page fades in on its own (140-220 ms fallback). */}
        <main
          ref={main}
          id="main"
          tabIndex={-1}
          key={pathname}
          className={cx('page', !supportsViewTransitions() && 'route-enter')}
        >
          <Suspense fallback={<RouteFallback label={t('state.loading')} />}>
            <Outlet />
          </Suspense>
        </main>
      </TopbarSlotProvider>
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
