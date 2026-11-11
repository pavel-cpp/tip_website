import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigationType } from 'react-router'
import { useI18n } from '../i18n'
import { cx } from '../lib/cx'
import { motionMode, playRouteMotion } from '../lib/routeMotion'
import { Skeleton } from './Skeleton'
import { Topbar } from './Topbar'
import { TopbarSlotProvider } from './TopbarSlot'

/**
 * Keeps document.title equal to the page heading (WCAG 2.4.2). Pages render exactly one h1; reading it
 * here avoids threading a title through every route, and the observer picks up headings that arrive
 * after data loads (a project name) or after a language switch. The observer follows the element itself
 * (not the path): the main element is re-created on every navigation, and while a lazy screen is still
 * loading its main is not there yet.
 */
function useHeadingTitle(el: HTMLElement | null, appName: string): void {
  useEffect(() => {
    if (!el) return
    const sync = () => {
      const h1 = el.querySelector('h1')?.textContent?.trim()
      document.title = h1 ? `${h1} · ${appName}` : appName
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [el, appName])
}

/**
 * Per-history-entry scroll restoration for client-side navigation: new pages start at the top, back and
 * forward return to where the entry was left. Runs in a layout effect so the route motion measures the
 * final position, and then starts that motion (the page is still unpainted at this point).
 */
function useRouteScroll(): void {
  const { pathname, key } = useLocation()
  const type = useNavigationType()
  const positions = useRef(new Map<string, number>())
  const current = useRef({ key, path: pathname })
  current.current.key = key
  useEffect(() => {
    const save = () => positions.current.set(current.current.key, window.scrollY)
    addEventListener('scroll', save, { passive: true })
    return () => removeEventListener('scroll', save)
  }, [])
  useLayoutEffect(() => {
    const moved = current.current.path !== pathname
    current.current.path = pathname
    if (moved) window.scrollTo(0, type === 'POP' ? (positions.current.get(key) ?? 0) : 0)
    playRouteMotion(pathname)
  }, [pathname, key, type])
}

/** App frame: persistent topbar plus the routed page. `minimal` hides user navigation (login). */
export function Shell({ minimal = false }: { minimal?: boolean }) {
  const { t } = useI18n()
  const { pathname } = useLocation()
  const main = useRef<HTMLElement | null>(null)
  const [mainEl, setMainEl] = useState<HTMLElement | null>(null)
  const bindMain = useCallback((el: HTMLElement | null) => {
    main.current = el
    setMainEl(el)
  }, [])
  const first = useRef(true)
  useHeadingTitle(mainEl, t('app.name'))
  useRouteScroll()

  // After a client-side navigation keyboard and screen-reader users start at the new page, not at the
  // link they activated (which has just been unmounted).
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    // A lazy screen may still be loading (its boundary hides main), so wait for a visible main, at most 3 s.
    const started = performance.now()
    let raf = 0
    const tryFocus = () => {
      const el = main.current
      if (el?.isConnected && (el.checkVisibility?.() ?? true)) el.focus({ preventScroll: true })
      else if (performance.now() - started < 3000) raf = requestAnimationFrame(tryFocus)
    }
    tryFocus()
    return () => cancelAnimationFrame(raf)
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
        {/*
          The boundary sits outside the keyed main on purpose: it stays mounted across navigations, so while
          the next screen's chunk loads inside a router transition the old page stays on screen (no skeleton
          flash). The fallback only shows on the very first load. Desktop pages are animated by
          lib/routeMotion.ts; touch screens fade each page in by CSS.
        */}
        <Suspense
          fallback={
            <main id="main" tabIndex={-1} className="page">
              <RouteFallback label={t('state.loading')} />
            </main>
          }
        >
          <main
            ref={bindMain}
            id="main"
            tabIndex={-1}
            key={pathname}
            className={cx('page', motionMode() === 'off' && 'route-enter')}
          >
            <Outlet />
          </main>
        </Suspense>
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
