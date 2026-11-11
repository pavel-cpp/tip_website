import { EASE, prefersReducedMotion } from './motion'

/*
 * Route transitions: the interface rearranges itself into the new page.
 *
 * Own engine on the Web Animations API (FLIP style), identical in Chrome, Firefox and Safari, no View
 * Transitions (their full-page snapshot layers were the measured source of lag):
 *
 *  1. capture: right before the history entry changes, the rects of the elements marked `data-morph`
 *     are read, ghosts of them are built (a flying copy of a title, a card surface, a picture) and the
 *     outgoing page is cloned. Nothing is awaited; the DOM is untouched.
 *  2. play: in a layout effect after the new route committed (before the first paint) the clone covers
 *     the new page and settles out, the ghosts fly from their old rect to the new one while the real
 *     element fades in under them, and the rest of the new page is revealed block by block.
 *
 * Only transform and opacity are animated (plus the corner radius of the one surface ghost), so the
 * work stays off the main thread. A new navigation cancels everything that is still running; any error
 * falls back to "no animation". Phones (touch) keep the CSS fade of `.route-enter`; reduced motion gets
 * a 120 ms opacity fade.
 */

export type MotionMode = 'full' | 'fade' | 'off'

export function motionMode(): MotionMode {
  if (typeof document === 'undefined' || typeof matchMedia !== 'function') return 'off'
  if (typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function') return 'off'
  if (!matchMedia('(hover: hover) and (pointer: fine) and (min-width: 700px)').matches) return 'off'
  return prefersReducedMotion() ? 'fade' : 'full'
}

/** Timings in ms (the page change as a whole stays under about 340 ms). */
export const ROUTE_MS = {
  fly: 340,
  cloneOut: 170,
  realFadeDelay: 150,
  realFade: 190,
  ghostFadeDelay: 210,
  ghostFade: 130,
  frameFadeDelay: 110,
  frameFade: 230,
  hold: 400,
  revealDelay: 70,
  reveal: 240,
  stagger: 40,
  crumb: 220,
  fade: 120,
} as const
const MAX_BLOCKS = 5
/** Marks that show up this late after the commit (a title set by an effect, a card thumb) still join. */
const LATE_MS = 450
/** A captured snapshot older than this belongs to a navigation that never committed. */
const STALE_MS = 1500

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------------------------

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Direction = { kind: 'in' | 'out' | 'side'; sign: 1 | -1 }

const SIBLINGS = ['/', '/profile', '/admin/users', '/admin/roles', '/admin/system']

/** Depth in the project hierarchy (list -> project -> settings); other screens are siblings (null). */
export function routeRank(path: string): number | null {
  if (path === '/') return 0
  const m = /^\/projects\/[^/]+(\/settings)?\/?$/.exec(path)
  if (!m) return null
  return m[1] ? 2 : 1
}

export const projectIdOf = (path: string): string | null => /^\/projects\/([^/]+)/.exec(path)?.[1] ?? null

/** Deeper pages rise in, shallower ones settle back; siblings slide along the order of the menu. */
export function navDirection(from: string, to: string): Direction {
  const a = routeRank(from)
  const b = routeRank(to)
  if (from === '/login') return { kind: 'in', sign: 1 }
  if (a !== null && b !== null && a !== b) return { kind: b > a ? 'in' : 'out', sign: 1 }
  const i = SIBLINGS.indexOf(from)
  const j = SIBLINGS.indexOf(to)
  return { kind: 'side', sign: i >= 0 && j >= 0 && j < i ? -1 : 1 }
}

/** Keys look like `title:<projectId>` or `heading`; ones naming another project are not candidates. */
export function keyWanted(key: string, ids: readonly (string | null)[]): boolean {
  const at = key.indexOf(':')
  if (at < 0) return true
  const id = key.slice(at + 1)
  return ids.includes(id)
}

/** Corner radius that stays `r` on screen while the box is stretched by (sx, sy). */
export const radiusAt = (r: number, sx: number, sy: number): string =>
  `${(r / (sx || 1)).toFixed(2)}px / ${(r / (sy || 1)).toFixed(2)}px`

/** The transform that puts a box laid out at `to` where `from` was (origin top left). */
export function invert(from: Rect, to: Rect): { dx: number; dy: number; sx: number; sy: number } {
  return {
    dx: from.x - to.x,
    dy: from.y - to.y,
    sx: to.w > 0 ? from.w / to.w : 1,
    sy: to.h > 0 ? from.h / to.h : 1,
  }
}

/** Where the new page is revealed from, per direction. */
export function revealFrom({ kind, sign }: Direction): string {
  if (kind === 'in') return 'translateY(16px)'
  if (kind === 'out') return 'translateY(-8px)'
  return `translateX(${18 * sign}px)`
}

/** How the outgoing page leaves, per direction. */
export function leaveTo({ kind, sign }: Direction): string {
  if (kind === 'in') return 'scale(0.985)'
  if (kind === 'out') return 'translateY(10px)'
  return `translateX(${-14 * sign}px)`
}

/** The visible blocks that are revealed one after another: the children of the first level with several. */
export function blocksOf(main: Element): HTMLElement[] {
  let node: Element = main
  for (let depth = 0; depth < 3; depth++) {
    const kids = [...node.children].filter(isBlock)
    const only = kids[0]
    if (kids.length === 1 && only) {
      node = only
      continue
    }
    return kids.slice(0, MAX_BLOCKS)
  }
  return [...node.children].filter(isBlock).slice(0, MAX_BLOCKS)
}

function isBlock(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false
  if (el.hidden || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false
  const cs = getComputedStyle(el)
  return (
    cs.display !== 'none' &&
    cs.display !== 'contents' &&
    cs.position !== 'fixed' &&
    cs.position !== 'absolute'
  )
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

interface Mark {
  key: string
  text: boolean
  rect: Rect
  ghost: HTMLElement
  /** The ghost of a frame keeps the old look only when the old element had one (a card), else it borrows the new. */
  plain: boolean
}

interface Snapshot {
  at: number
  mode: MotionMode
  dir: Direction
  marks: Map<string, Mark>
  clone: HTMLElement | null
  cloneRect: Rect | null
  scrolls: Array<[number, number, number]>
  slot: HTMLElement | null
  slotRect: Rect | null
}

interface Active {
  anims: Animation[]
  nodes: Element[]
  observer: MutationObserver | null
  timer: ReturnType<typeof setTimeout> | undefined
  hard?: ReturnType<typeof setTimeout>
}

let committed = typeof location === 'undefined' ? '/' : location.pathname
let pending: Snapshot | null = null
let active: Active | null = null

const rectOf = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height })

function contentRect(el: HTMLElement, text: boolean): Rect {
  const r = el.getBoundingClientRect()
  if (!text) return rectOf(r)
  const cs = getComputedStyle(el)
  const n = (v: string) => Number.parseFloat(v) || 0
  const l = n(cs.paddingLeft) + n(cs.borderLeftWidth)
  const t = n(cs.paddingTop) + n(cs.borderTopWidth)
  const rr = n(cs.paddingRight) + n(cs.borderRightWidth)
  const b = n(cs.paddingBottom) + n(cs.borderBottomWidth)
  return { x: r.left + l, y: r.top + t, w: Math.max(0, r.width - l - rr), h: Math.max(0, r.height - t - b) }
}

const inViewport = (r: Rect): boolean =>
  r.w > 0 && r.h > 0 && r.x + r.w > 0 && r.y + r.h > 0 && r.x < innerWidth && r.y < innerHeight

const isFrame = (key: string): boolean => key.startsWith('hero')

/** Stops everything that is running and removes what it added; the page is left exactly as React rendered it. */
function finish(): void {
  const a = active
  active = null
  if (!a) return
  clearTimeout(a.timer)
  clearTimeout(a.hard)
  a.observer?.disconnect()
  for (const anim of a.anims) {
    try {
      anim.cancel()
    } catch {
      // already gone
    }
  }
  for (const n of a.nodes) n.remove()
}

function layer(kind: 'under' | 'clone' | 'ghost'): HTMLElement {
  const el = document.createElement('div')
  el.className = `route-layer route-layer-${kind}`
  el.setAttribute('aria-hidden', 'true')
  el.inert = true
  document.body.appendChild(el)
  return el
}

/** Makes a copy that can sit outside the app: no ids or focus targets, inline styles set through the CSSOM. */
function sanitize(orig: Element, clone: Element): Array<[number, number, number]> {
  const o = orig.querySelectorAll('*')
  const c = clone.querySelectorAll('*')
  const scrolls: Array<[number, number, number]> = []
  const n = Math.min(o.length, c.length)
  for (let i = 0; i < n; i++) {
    const src = o[i] as HTMLElement
    const dst = c[i] as HTMLElement
    if (src.hasAttribute('style')) dst.style.cssText = src.style.cssText
    if (src.firstElementChild && (src.scrollTop || src.scrollLeft))
      scrolls.push([i, src.scrollTop, src.scrollLeft])
    if (
      src instanceof HTMLCanvasElement &&
      dst instanceof HTMLCanvasElement &&
      getComputedStyle(src).opacity !== '0'
    ) {
      try {
        dst.getContext('2d')?.drawImage(src, 0, 0)
      } catch {
        // tainted or empty canvas: leave it blank
      }
    }
    if (dst.id) dst.removeAttribute('id')
    dst.removeAttribute('tabindex')
    dst.removeAttribute('data-flip-id')
    const key = dst.getAttribute('data-morph')
    if (key !== null) {
      dst.setAttribute('data-mk', key)
      dst.removeAttribute('data-morph')
    }
  }
  return scrolls
}

/** Sticky and fixed elements have no scroll container in the clone, so they are pinned where they were. */
function pinPositioned(orig: Element, clone: Element, root: Rect): void {
  const o = orig.querySelectorAll('*')
  const c = clone.querySelectorAll('*')
  if (o.length > 4000) return
  const n = Math.min(o.length, c.length)
  for (let i = 0; i < n; i++) {
    const src = o[i] as HTMLElement
    const pos = getComputedStyle(src).position
    if (pos !== 'sticky' && pos !== 'fixed') continue
    const r = src.getBoundingClientRect()
    const dst = c[i] as HTMLElement
    dst.style.position = 'absolute'
    dst.style.inset = 'auto'
    dst.style.margin = '0'
    dst.style.left = `${r.left - root.x}px`
    dst.style.top = `${r.top - root.y}px`
    dst.style.width = `${r.width}px`
    dst.style.height = `${r.height}px`
  }
}

function copyBox(from: CSSStyleDeclaration, to: HTMLElement): void {
  to.style.backgroundColor = from.backgroundColor
  to.style.backgroundImage = from.backgroundImage
  to.style.backgroundSize = from.backgroundSize
  to.style.backgroundPosition = from.backgroundPosition
  to.style.backgroundRepeat = from.backgroundRepeat
  to.style.border = `${from.borderTopWidth} ${from.borderTopStyle} ${from.borderTopColor}`
  to.style.borderRadius = from.borderTopLeftRadius
  to.style.boxShadow = from.boxShadow
}

function isPlain(cs: CSSStyleDeclaration): boolean {
  const clear = cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent'
  return clear && cs.backgroundImage === 'none' && (Number.parseFloat(cs.borderTopWidth) || 0) === 0
}

/**
 * A picture inside the element is shown by the flying ghost. Images are cloned here; a canvas is not copied a
 * second time: the ghost takes the already copied canvas out of the outgoing page clone when it starts to fly.
 */
function copyMedia(el: HTMLElement, ghost: HTMLElement): void {
  // The ticket panel has two canvases that cross-fade; the one in front is the picture.
  const src =
    el.querySelector<HTMLElement>('canvas[data-front]') ?? el.querySelector<HTMLElement>('canvas, img')
  if (!src) return
  if (src instanceof HTMLCanvasElement) {
    ghost.dataset.media = src.hasAttribute('data-front') ? 'front' : 'canvas'
    return
  }
  if (src instanceof HTMLImageElement) {
    const i = document.createElement('img')
    i.src = src.currentSrc || src.src
    i.alt = ''
    fillGhost(i, src)
    ghost.appendChild(i)
  }
}

function fillGhost(out: HTMLElement, src: HTMLElement): void {
  out.style.position = 'absolute'
  out.style.inset = '0'
  out.style.width = '100%'
  out.style.height = '100%'
  out.style.objectFit = getComputedStyle(src).objectFit || 'contain'
}

function buildGhost(
  el: HTMLElement,
  text: boolean,
  rect: Rect,
  frame: boolean,
): { ghost: HTMLElement; plain: boolean } {
  const cs = getComputedStyle(el)
  const ghost = document.createElement('div')
  ghost.className = 'route-ghost'
  ghost.style.width = `${rect.w}px`
  ghost.style.height = `${rect.h}px`
  if (text) {
    ghost.textContent = el instanceof HTMLInputElement ? el.value : (el.textContent ?? '')
    ghost.style.fontFamily = cs.fontFamily
    ghost.style.fontSize = cs.fontSize
    ghost.style.fontWeight = cs.fontWeight
    ghost.style.fontStyle = cs.fontStyle
    ghost.style.letterSpacing = cs.letterSpacing
    ghost.style.lineHeight = `${rect.h}px`
    ghost.style.color = cs.color
    ghost.style.whiteSpace = 'nowrap'
    ghost.style.overflow = 'hidden'
    ghost.style.textOverflow = 'ellipsis'
    return { ghost, plain: false }
  }
  copyBox(cs, ghost)
  // A frame (the whole workspace) is only a surface; the pictures inside it belong to the pictures' own ghosts.
  if (!frame) copyMedia(el, ghost)
  return { ghost, plain: isPlain(cs) }
}

function readMarks(ids: readonly (string | null)[]): Map<string, Mark> {
  const marks = new Map<string, Mark>()
  for (const el of document.querySelectorAll<HTMLElement>('[data-morph]')) {
    const key = el.dataset.morph
    if (!key || marks.has(key) || !keyWanted(key, ids)) continue
    const text = el.hasAttribute('data-morph-text')
    const rect = contentRect(el, text)
    if (!inViewport(rect)) continue
    const { ghost, plain } = buildGhost(el, text, rect, isFrame(key))
    marks.set(key, { key, text, rect, ghost, plain })
  }
  return marks
}

function takeSnapshot(to: string): void {
  finish()
  pending = null
  const mode = motionMode()
  if (mode === 'off' || to === committed) return
  const dir = navDirection(committed, to)
  const snap: Snapshot = {
    at: performance.now(),
    mode,
    dir,
    marks: new Map(),
    clone: null,
    cloneRect: null,
    scrolls: [],
    slot: null,
    slotRect: null,
  }
  if (mode === 'full') {
    const main = document.querySelector<HTMLElement>('main.page')
    if (!main) return
    snap.marks = readMarks([projectIdOf(to), projectIdOf(committed)])
    const rect = rectOf(main.getBoundingClientRect())
    const clone = main.cloneNode(true) as HTMLElement
    snap.scrolls = sanitize(main, clone)
    pinPositioned(main, clone, rect)
    clone.removeAttribute('id')
    clone.removeAttribute('tabindex')
    clone.removeAttribute('data-morph')
    clone.classList.remove('route-enter')
    snap.clone = clone
    snap.cloneRect = rect
    const slot = document.querySelector<HTMLElement>('.topbar-slot')
    if (slot?.firstElementChild) {
      const sclone = slot.cloneNode(true) as HTMLElement
      sanitize(slot, sclone)
      snap.slot = sclone
      snap.slotRect = rectOf(slot.getBoundingClientRect())
    }
  }
  pending = snap
}

/** Where the old page and top bar content are copied to: boxes inside a fixed layer, at their old viewport position. */
function place(el: HTMLElement, r: Rect): void {
  el.style.position = 'absolute'
  el.style.left = `${r.x}px`
  el.style.top = `${r.y}px`
  el.style.width = `${r.w}px`
  el.style.height = `${r.h}px`
  el.style.margin = '0'
  el.style.flex = 'none'
}

interface Run extends Active {
  snap: Snapshot
  main: HTMLElement
  /** Backdrop and frame ghosts: above the new page, below the outgoing content. */
  under: HTMLElement
  /** Text and picture ghosts and the old top bar content: above everything of the page. */
  ghosts: HTMLElement
  claimed: Set<string>
  slot: HTMLElement | null
  box?: HTMLElement
  backdrop?: HTMLElement
}

function pairMark(run: Run, el: HTMLElement, mark: Mark, extraDelay: number): void {
  const text = mark.text
  const to = contentRect(el, text)
  if (!inViewport(to)) return
  const cs = getComputedStyle(el)
  const frame = isFrame(mark.key)
  const g = mark.ghost
  // A frame that was plain in the old page (the workspace) shrinks into the look of the new element (a card).
  if (mark.plain && !text) copyBox(cs, g)
  // A hovered card has an accent border; the surface that grows out of it keeps the neutral one.
  if (frame && !text) g.style.borderColor = 'var(--border-strong)'
  const radius = Number.parseFloat(g.style.borderTopLeftRadius) || 0
  let from: string
  let rest: string
  if (text) {
    // Laid out at the old rect, moved to the new one; font size follows by a uniform scale (no stretched letters).
    const k = (Number.parseFloat(cs.fontSize) || 1) / (Number.parseFloat(g.style.fontSize) || 1)
    g.style.left = `${mark.rect.x}px`
    g.style.top = `${mark.rect.y}px`
    g.style.width = `${mark.rect.w}px`
    g.style.height = `${mark.rect.h}px`
    g.style.transformOrigin = '0 50%'
    from = 'translate(0px, 0px) scale(1)'
    rest = `translate(${to.x - mark.rect.x}px, ${to.y + to.h / 2 - (mark.rect.y + mark.rect.h / 2)}px) scale(${k})`
  } else {
    // Laid out at the new rect, stretched back to the old one (the stretch is undone by the animation).
    const inv = invert(mark.rect, to)
    g.style.left = `${to.x}px`
    g.style.top = `${to.y}px`
    g.style.width = `${to.w}px`
    g.style.height = `${to.h}px`
    g.style.transformOrigin = '0 0'
    from = `translate(${inv.dx}px, ${inv.dy}px) scale(${inv.sx}, ${inv.sy})`
    rest = 'translate(0px, 0px) scale(1, 1)'
    if (radius > 0) {
      run.anims.push(
        g.animate([{ borderRadius: radiusAt(radius, inv.sx, inv.sy) }, { borderRadius: `${radius}px` }], {
          duration: ROUTE_MS.fly,
          easing: EASE.drawer,
          delay: extraDelay,
          fill: 'backwards',
        }),
      )
    }
  }
  ;(frame ? run.under : run.ghosts).appendChild(g)
  run.nodes.push(g)
  run.anims.push(
    g.animate([{ transform: from }, { transform: rest }], {
      duration: ROUTE_MS.fly,
      easing: EASE.drawer,
      delay: extraDelay,
      fill: 'both',
    }),
    g.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: frame ? ROUTE_MS.frameFade : ROUTE_MS.ghostFade,
      delay: extraDelay + (frame ? ROUTE_MS.frameFadeDelay : ROUTE_MS.ghostFadeDelay),
      easing: EASE.out,
      fill: 'both',
    }),
  )
  // The real element waits (invisible) until the ghost has almost arrived, then fades in.
  if (!frame) {
    run.anims.push(
      el.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: ROUTE_MS.realFade,
        delay: extraDelay + ROUTE_MS.realFadeDelay,
        easing: EASE.out,
        fill: 'backwards',
      }),
    )
  }
  // Its twin in the outgoing page is replaced by the ghost (which takes over the twin's canvas, if it had one).
  const key = CSS.escape(mark.key)
  const twin = run.snap.clone?.querySelector<HTMLElement>(`[data-mk="${key}"]`)
  if (twin) {
    if (g.dataset.media) {
      const c = twin.querySelector<HTMLCanvasElement>(
        g.dataset.media === 'front' ? 'canvas[data-front]' : 'canvas',
      )
      if (c) {
        fillGhost(c, c)
        c.style.opacity = '1'
        g.appendChild(c)
      }
    }
    twin.style.visibility = 'hidden'
  }
  const stale = run.slot?.querySelector<HTMLElement>(`[data-mk="${key}"]`)
  if (stale) stale.style.visibility = 'hidden'
}

/** A page is ready to be revealed once its frame is there: no loading skeletons, or one of the marked elements. */
function pageReady(main: HTMLElement): boolean {
  if (main.childElementCount === 0) return false
  if (main.querySelector('[data-morph]')) return true
  return !main.querySelector('.skeleton, [aria-busy="true"]')
}

/** The outgoing page is put back on top of the new one, still and opaque, so nothing of the new page shows yet. */
function mount(snap: Snapshot, main: HTMLElement): Run {
  const run: Run = {
    anims: [],
    nodes: [],
    observer: null,
    timer: undefined,
    snap,
    main,
    under: layer('under'),
    ghosts: layer('ghost'),
    claimed: new Set(),
    slot: snap.slot,
  }
  // DOM order = paint order inside the same z-index: backdrop and frame ghosts, then the old content, then the rest.
  const holder = layer('clone')
  document.body.insertBefore(run.under, run.ghosts)
  document.body.insertBefore(holder, run.ghosts)
  run.nodes.push(run.under, holder, run.ghosts)

  const backdrop = document.createElement('div')
  backdrop.className = 'route-backdrop'
  run.under.appendChild(backdrop)
  if (snap.clone && snap.cloneRect) {
    const box = document.createElement('div')
    place(box, snap.cloneRect)
    box.style.overflow = 'hidden'
    box.style.contain = 'layout paint style'
    box.appendChild(snap.clone)
    snap.clone.style.flex = 'none'
    snap.clone.style.width = '100%'
    holder.appendChild(box)
    const kids = box.querySelectorAll('*')
    for (const [i, top, left] of snap.scrolls) {
      const k = kids[i] as HTMLElement | undefined
      if (k) {
        k.scrollTop = top
        k.scrollLeft = left
      }
    }
    run.box = box
  }
  run.backdrop = backdrop
  if (snap.slot && snap.slotRect) {
    place(snap.slot, snap.slotRect)
    run.ghosts.appendChild(snap.slot)
  }
  return run
}

/** The motion proper: the old page settles out, shared elements fly, the new page is revealed. */
function start(run: Run): void {
  const { snap, main } = run
  const started = performance.now()

  // 1. The outgoing page settles out.
  const out = { duration: ROUTE_MS.cloneOut, easing: EASE.out, fill: 'both' as const }
  if (run.backdrop) run.anims.push(run.backdrop.animate([{ opacity: 1 }, { opacity: 0 }], out))
  if (run.box) {
    run.anims.push(
      run.box.animate(
        [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: leaveTo(snap.dir) },
        ],
        out,
      ),
    )
  }
  if (snap.slot) {
    run.anims.push(
      snap.slot.animate([{ opacity: 1 }, { opacity: 0 }], { ...out, duration: ROUTE_MS.cloneOut - 30 }),
    )
  }

  // 2. Elements that exist on both sides fly; frames first so pictures and titles ride on top.
  const claim = (el: HTMLElement) => {
    const key = el.dataset.morph
    if (!key || run.claimed.has(key)) return
    const mark = snap.marks.get(key)
    if (!mark) return
    run.claimed.add(key)
    pairMark(run, el, mark, 0)
  }
  const found = [...document.querySelectorAll<HTMLElement>('[data-morph]')]
  found.sort((a, b) => Number(isFrame(b.dataset.morph ?? '')) - Number(isFrame(a.dataset.morph ?? '')))
  for (const el of found) claim(el)

  // 3. The rest of the new page is revealed block by block.
  blocksOf(main).forEach((block, i) => {
    run.anims.push(
      block.animate(
        [
          { opacity: 0, transform: revealFrom(snap.dir) },
          { opacity: 1, transform: 'none' },
        ],
        {
          duration: ROUTE_MS.reveal,
          delay: ROUTE_MS.revealDelay + i * ROUTE_MS.stagger,
          easing: EASE.out,
          fill: 'backwards',
        },
      ),
    )
  })
  for (const side of main.querySelectorAll<HTMLElement>('[data-reveal="side"]')) {
    run.anims.push(
      side.animate(
        [
          { opacity: 0, transform: 'translateX(28px)' },
          { opacity: 1, transform: 'none' },
        ],
        {
          duration: ROUTE_MS.reveal + 40,
          delay: ROUTE_MS.revealDelay + 60,
          easing: EASE.out,
          fill: 'backwards',
        },
      ),
    )
  }

  // 4. Things that arrive a moment later (crumbs set by an effect, a late thumbnail) still join.
  const slot = document.querySelector<HTMLElement>('.topbar-slot')
  run.observer?.disconnect()
  run.observer = new MutationObserver((records) => {
    if (active !== run || performance.now() - started > LATE_MS) return
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (!(node instanceof HTMLElement)) continue
        if (rec.target === slot) {
          run.anims.push(
            node.animate(
              [
                { opacity: 0, transform: 'translateX(10px)' },
                { opacity: 1, transform: 'none' },
              ],
              { duration: ROUTE_MS.crumb, delay: 40, easing: EASE.out, fill: 'backwards' },
            ),
          )
        }
        const late = node.matches('[data-morph]')
          ? [node]
          : [...node.querySelectorAll<HTMLElement>('[data-morph]')]
        for (const el of late) claim(el)
      }
    }
  })
  run.observer.observe(main, { childList: true, subtree: true })
  if (slot) run.observer.observe(slot, { childList: true, subtree: true })

  // 5. Everything is cleaned up once the last animation (late joiners included) has ended.
  clearTimeout(run.hard)
  run.hard = setTimeout(
    () => {
      if (active === run) finish()
    },
    LATE_MS + ROUTE_MS.fly + 700,
  )
  const settle = async () => {
    let seen = -1
    while (active === run && seen !== run.anims.length) {
      seen = run.anims.length
      await Promise.all(run.anims.map((a) => a.finished.catch(() => undefined)))
    }
    if (active !== run) return
    const wait = LATE_MS - (performance.now() - started)
    if (wait > 0) run.timer = setTimeout(() => void settle(), wait)
    else finish()
  }
  void settle()
}

/**
 * Starts the motion in the same frame but outside the commit task, so the page's own layout and the engine's
 * measuring do not add up to one long task. The timer is a safety net for frames that never come (hidden tab).
 */
function startSoon(run: Run): void {
  let done = false
  const once = () => {
    if (done || active !== run) return
    done = true
    try {
      start(run)
    } catch {
      finish()
    }
  }
  requestAnimationFrame(once)
  setTimeout(once, 60)
}

function play(snap: Snapshot): void {
  const main = document.querySelector<HTMLElement>('main.page')
  if (!main) return
  if (snap.mode === 'fade') {
    const a = main.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ROUTE_MS.fade, easing: EASE.out })
    active = { anims: [a], nodes: [], observer: null, timer: undefined }
    void a.finished.then(finish, () => undefined)
    return
  }
  const run = mount(snap, main)
  active = run
  if (pageReady(main)) {
    startSoon(run)
    return
  }
  // The new page is still loading: the old one stays on screen until its frame arrives (at most HOLD_MS).
  const go = () => {
    if (active !== run) return
    clearTimeout(run.timer)
    run.observer?.disconnect()
    startSoon(run)
  }
  run.observer = new MutationObserver(() => {
    if (pageReady(main)) go()
  })
  run.observer.observe(main, { childList: true, subtree: true })
  const slot = document.querySelector<HTMLElement>('.topbar-slot')
  if (slot) run.observer.observe(slot, { childList: true, subtree: true })
  run.timer = setTimeout(go, ROUTE_MS.hold)
}

/** Called by the shell after each route commit, before paint. Never throws. */
export function playRouteMotion(path: string): void {
  const snap = pending
  pending = null
  committed = path
  if (!snap) return
  try {
    if (performance.now() - snap.at > STALE_MS) return
    play(snap)
  } catch {
    finish()
  }
}

/** Observes history changes once, before the router mounts. Replace is ignored (redirects) except login. */
export function installRouteMotion(): void {
  if (typeof history === 'undefined') return
  const target = (url?: string | URL | null): string => {
    try {
      return new URL(String(url ?? location.href), location.href).pathname
    } catch {
      return committed
    }
  }
  const safe = (to: string) => {
    try {
      takeSnapshot(to)
    } catch {
      pending = null
    }
  }
  const push = history.pushState.bind(history)
  history.pushState = (data, unused, url) => {
    safe(target(url))
    push(data, unused, url)
  }
  const replace = history.replaceState.bind(history)
  history.replaceState = (data, unused, url) => {
    if (committed === '/login') safe(target(url))
    replace(data, unused, url)
  }
  // Registered before the router's own listener, so the old page is still on screen when it runs.
  addEventListener('popstate', () => safe(location.pathname))
}
