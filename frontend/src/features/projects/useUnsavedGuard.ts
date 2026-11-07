import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

/**
 * Leave guard for the settings screen. The app uses a declarative <BrowserRouter>, which has no
 * `useBlocker`, so the three exits are covered by hand:
 *  - closing/reloading the tab: `beforeunload`;
 *  - in-app links: a capture-phase click handler that defers the navigation;
 *  - the browser Back button: a sentinel history entry pushed once the form becomes dirty.
 * `pending` is true while the "leave without saving?" dialog should be shown.
 */
export function useUnsavedGuard(dirty: boolean) {
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const target = useRef<string | number | null>(null)
  const dirtyRef = useRef(dirty)
  const sentinel = useRef(false)
  dirtyRef.current = dirty

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      e.preventDefault()
    }
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current || e.defaultPrevented || e.button !== 0) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || a.target === '_blank' || a.origin !== window.location.origin) return
      const to = a.pathname + a.search + a.hash
      if (to === window.location.pathname + window.location.search) return
      e.preventDefault()
      e.stopPropagation()
      target.current = to
      setPending(true)
    }
    const onPop = () => {
      if (!dirtyRef.current) return
      // Back from the sentinel lands on this same page: ask, and go back further only if confirmed.
      target.current = -1
      setPending(true)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('click', onClick, true)
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('popstate', onPop)
    }
  }, [])

  useEffect(() => {
    if (dirty && !sentinel.current) {
      sentinel.current = true
      window.history.pushState(window.history.state, '', window.location.href)
    }
  }, [dirty])

  const stay = useCallback(() => {
    setPending(false)
    // After a Back-triggered prompt the sentinel was consumed; put it back.
    if (target.current === -1) window.history.pushState(window.history.state, '', window.location.href)
    target.current = null
  }, [])

  /** Confirms leaving and runs the deferred navigation. */
  const leave = useCallback(() => {
    const to = target.current
    target.current = null
    dirtyRef.current = false
    setPending(false)
    if (typeof to === 'number') void navigate(to)
    else if (to) void navigate(to, { viewTransition: true })
  }, [navigate])

  /** For buttons that leave the screen programmatically (Cancel, close). */
  const requestLeave = useCallback(
    (to: string) => {
      if (!dirtyRef.current) {
        void navigate(to, { viewTransition: true })
        return
      }
      target.current = to
      setPending(true)
    },
    [navigate],
  )

  return { pending, stay, leave, requestLeave }
}
