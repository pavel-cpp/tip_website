import { DURATION, prefersReducedMotion } from './motion'

export function supportsViewTransitions(): boolean {
  return typeof document.startViewTransition === 'function'
}

/**
 * Runs a synchronous DOM/state update inside a View Transition when the browser supports it,
 * otherwise applies it and plays a short fade on the root element. Reduced motion skips both.
 */
export function withViewTransition(update: () => void): void {
  if (prefersReducedMotion()) {
    update()
    return
  }
  if (document.startViewTransition) {
    document.startViewTransition(update)
    return
  }
  update()
  const root = document.getElementById('root')
  if (!root) return
  root.classList.remove('vt-fade')
  void root.offsetWidth // restart the animation when called twice in a row
  root.classList.add('vt-fade')
  setTimeout(() => root.classList.remove('vt-fade'), DURATION.fast)
}

// ---------------------------------------------------------------------------------------------
// Route transitions (desktop). Every navigation that asks for a View Transition (router links and
// `navigate(..., { viewTransition: true })`) goes through document.startViewTransition, so wrapping it
// once gives one place to pick the motion, gate it by device, and cover back/forward as well.
// ---------------------------------------------------------------------------------------------

export type NavKind = 'drill' | 'back' | 'sibling'

/** Depth in the project hierarchy (list -> project -> settings); other screens are siblings (null). */
export function routeRank(path: string): number | null {
  if (path === '/') return 0
  const m = /^\/projects\/[^/]+(\/settings)?\/?$/.exec(path)
  if (!m) return null
  return m[1] ? 2 : 1
}

export function navKind(from: string, to: string): NavKind {
  const a = routeRank(from)
  const b = routeRank(to)
  if (a === null || b === null || a === b) return 'sibling'
  return b > a ? 'drill' : 'back'
}

/** Full-size motion only for desktop pointer devices; phones and tablets get a lighter fade instead. */
export function desktopMotion(): boolean {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(hover: hover) and (pointer: fine) and (min-width: 700px)').matches &&
    !prefersReducedMotion()
  )
}

/** True when route changes are animated by View Transitions (otherwise the page fades in by CSS). */
export function routeTransitionsActive(): boolean {
  return supportsViewTransitions() && desktopMotion()
}

let committedPath = typeof location === 'undefined' ? '/' : location.pathname
let waiting: (() => void) | undefined

/** Project whose card is morphing into (or back from) the workspace in the running transition. */
let heroId: string | null = null
let navSeq = 0

const projectIdOf = (path: string): string | null => /^\/projects\/([^/]+)/.exec(path)?.[1] ?? null

/** The list card of a project, only when it is on screen (a morph from outside the viewport looks like a glitch). */
function visibleCard(id: string): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(`.project-card[data-flip-id="${CSS.escape(id)}"]`)
  const r = el?.getBoundingClientRect()
  return el && r && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth ? el : null
}

/**
 * The shell calls this after each route commit: it is the base for the next direction and it releases
 * a held back/forward transition. When a project is shrinking back into its list card, the card gets its
 * transition name here, right after the list has rendered and before the new frame is captured.
 */
export function routeCommitted(path: string): void {
  committedPath = path
  if (heroId && routeRank(path) === 0) visibleCard(heroId)?.setAttribute('data-hero', '')
  const release = waiting
  waiting = undefined
  if (release) whenCrumbsReady(path, release)
}

/**
 * The project crumbs in the top bar are set by the page's own effects, right after the route commit. The new
 * frame is captured when the transition callback resolves, so hold it back until they exist (named elements
 * such as the project title must be there to find their partner), at most 120 ms. Timers, not animation
 * frames: rendering is suspended while a transition waits for its callback, so rAF would not fire at all.
 */
function whenCrumbsReady(path: string, done: () => void): void {
  const rank = routeRank(path)
  if (!rank) return done()
  const started = performance.now()
  const poll = () => {
    if (document.querySelector('header.topbar .wsbar-title') || performance.now() - started > 120) done()
    else setTimeout(poll, 4)
  }
  poll()
}

function startNav(native: Document['startViewTransition'], cb: () => void | Promise<void>): ViewTransition {
  const root = document.documentElement
  const from = committedPath
  const to = location.pathname
  const a = routeRank(from)
  const b = routeRank(to)
  delete root.dataset.sheet
  delete root.dataset.morph
  for (const el of document.querySelectorAll('[data-hero]')) el.removeAttribute('data-hero')
  root.dataset.nav = navKind(from, to)
  // Project <-> settings is a sheet rising over, or sinking back to, the workspace.
  if ((a === 1 && b === 2) || (a === 2 && b === 1)) root.dataset.sheet = b === 2 ? 'open' : 'close'
  // List <-> project: the card and the workspace are one shared element.
  if (a === 0 && b === 1) {
    heroId = projectIdOf(to)
    const card = heroId ? visibleCard(heroId) : null
    if (card) {
      card.setAttribute('data-hero', '')
      root.dataset.morph = 'open'
    } else heroId = null
  } else if (a === 1 && b === 0) {
    heroId = projectIdOf(from)
    if (heroId) root.dataset.morph = 'close'
  }
  const mine = ++navSeq
  const t = native.call(document, cb)
  void t.finished.finally(() => {
    if (mine !== navSeq) return // a newer transition owns the flags now
    delete root.dataset.nav
    delete root.dataset.sheet
    delete root.dataset.morph
    heroId = null
    for (const el of document.querySelectorAll('[data-hero]')) el.removeAttribute('data-hero')
  })
  return t
}

/** Resolves once the shell has committed the current URL (or after 600 ms, so a stuck render never freezes the page). */
function committed(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (committedPath === location.pathname) return resolve()
    waiting = resolve
    setTimeout(resolve, 600)
  })
}

/**
 * Safe to call once at startup, before the router mounts; a no-op where View Transitions do not exist
 * (the CSS fallback applies). The router in declarative mode never starts transitions itself, so history
 * changes are observed here.
 * - pushState (links, navigate): the browser captures the old frame, then the update waits for the commit.
 * - popstate (back/forward): the router would re-render synchronously, before the old frame is captured, so
 *   the event is held back and replayed to the router from inside the transition callback.
 * Replace is left alone (redirects).
 */
export function installRouteTransitions(): void {
  const native = document.startViewTransition
  if (!native) return
  const push = history.pushState.bind(history)
  history.pushState = (...args) => {
    push(...args)
    if (location.pathname !== committedPath && desktopMotion()) startNav(native, committed)
  }
  let replaying = false
  addEventListener('popstate', (e) => {
    if (replaying || location.pathname === committedPath || !desktopMotion()) return
    e.stopImmediatePropagation()
    startNav(native, () => {
      replaying = true
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
      replaying = false
      return committed()
    })
  })
}
