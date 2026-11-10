import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useRef, useState } from 'react'
import { DURATION, EASE, prefersReducedMotion } from '../../lib/motion'
import type { ProjectStatus } from './api'
import { insertionIndex } from './order'

// Touch needs a long press so that a plain swipe keeps scrolling the page; a mouse starts after a few px.
const PRESS_MS = 350
const MOUSE_SLOP = 5
const TOUCH_SLOP = 8
// Auto-scroll while the pointer is near the top or bottom edge of the viewport.
const EDGE = 72
const MAX_SCROLL = 18

export interface DropTarget {
  status: ProjectStatus
  /** Index in the section without the dragged card. */
  index: number
  /** Insertion marker in viewport coordinates; null for an empty section. */
  line: { x: number; y: number; h: number } | null
}

interface Options {
  /** False disables dragging altogether (search active, no permission). */
  enabled: boolean
  /** project.update: reorder inside a section. */
  canReorder: boolean
  /** project.finish with access to finished projects: drop into the other section. */
  canMove: boolean
  root: RefObject<HTMLElement | null>
  /**
   * Called with the drop result and the card's rectangle at release. Returns false when nothing
   * changed, in which case the card glides back to where it was.
   */
  onDrop: (
    id: string,
    from: ProjectStatus,
    to: ProjectStatus,
    index: number,
    rect: { left: number; top: number },
  ) => boolean
}

interface Session {
  id: string
  from: ProjectStatus
  el: HTMLElement
  pointerId: number
  touch: boolean
  startX: number
  startY: number
  scrollY0: number
  x: number
  y: number
  active: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  raf: number
  target: DropTarget | null
}

const same = (a: DropTarget | null, b: DropTarget | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.status === b.status &&
    a.index === b.index &&
    a.line?.x === b.line?.x &&
    a.line?.y === b.line?.y &&
    a.line?.h === b.line?.h)

/**
 * Pointer-event drag and drop for the project cards (mouse and touch, no library). The card follows
 * the pointer through a transform; the insertion point is a marker line computed from the live card
 * rectangles, and the actual move happens on release, where the page animates it with FLIP.
 * Keyboard users move cards through the card menu instead.
 */
export function useProjectDnd(options: Options) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [target, setTarget] = useState<DropTarget | null>(null)
  const opts = useRef(options)
  opts.current = options
  const session = useRef<Session | null>(null)
  const handlers = useRef<ReturnType<typeof makeHandlers> | null>(null)

  function makeHandlers() {
    const computeTarget = (s: Session): DropTarget | null => {
      const o = opts.current
      const root = o.root.current
      if (!root) return null
      for (const section of root.querySelectorAll<HTMLElement>('[data-drop-section]')) {
        const status = section.dataset.dropSection as ProjectStatus
        const r = section.getBoundingClientRect()
        const inside = s.x >= r.left - 12 && s.x <= r.right + 12 && s.y >= r.top - 12 && s.y <= r.bottom + 12
        if (!inside) continue
        if (status === s.from ? !o.canReorder : !o.canMove) return null
        const rects = [...section.querySelectorAll<HTMLElement>('[data-card-id]')]
          .filter((el) => el.dataset.cardId !== s.id)
          .map((el) => el.getBoundingClientRect())
        const index = insertionIndex(rects, { x: s.x, y: s.y })
        let line: DropTarget['line'] = null
        const at = rects[index]
        const last = rects[rects.length - 1]
        if (at) line = { x: Math.round(at.left - 8), y: Math.round(at.top), h: Math.round(at.height) }
        else if (last)
          line = { x: Math.round(last.right + 8), y: Math.round(last.top), h: Math.round(last.height) }
        return { status, index, line }
      }
      return null
    }

    const update = (s: Session) => {
      const dy = s.y - s.startY + (window.scrollY - s.scrollY0)
      s.el.style.transform = `translate3d(${s.x - s.startX}px, ${dy}px, 0) scale(1.03)`
      const next = computeTarget(s)
      if (!same(next, s.target)) {
        s.target = next
        setTarget(next)
      }
    }

    const tick = (s: Session) => {
      if (session.current !== s || !s.active) return
      const h = window.innerHeight
      let speed = 0
      if (s.y < EDGE) speed = -MAX_SCROLL * (1 - s.y / EDGE)
      else if (s.y > h - EDGE) speed = MAX_SCROLL * (1 - (h - s.y) / EDGE)
      if (speed !== 0) {
        window.scrollBy(0, speed)
        update(s)
      }
      s.raf = requestAnimationFrame(() => tick(s))
    }

    const begin = (s: Session) => {
      s.active = true
      setDragId(s.id)
      document.body.classList.add('is-dnd')
      navigator.vibrate?.(8)
      update(s)
      s.raf = requestAnimationFrame(() => tick(s))
    }

    const finish = (s: Session, commit: boolean) => {
      clearTimeout(s.timer)
      cancelAnimationFrame(s.raf)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey)
      session.current = null
      if (!s.active) return
      document.body.classList.remove('is-dnd')
      // The click that ends a drag must not open the project behind the card.
      const swallow = (e: Event) => {
        e.preventDefault()
        e.stopPropagation()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, true), 300)

      const rect = s.el.getBoundingClientRect()
      const t = commit ? s.target : null
      const changed = t ? opts.current.onDrop(s.id, s.from, t.status, t.index, rect) : false
      setDragId(null)
      setTarget(null)
      if (changed) return // useFlip clears the transform and glides the card to its new slot
      const el = s.el
      const from = el.style.transform
      el.style.transform = ''
      if (!prefersReducedMotion() && typeof el.animate === 'function') {
        el.animate([{ transform: from }, { transform: 'none' }], {
          duration: DURATION.base,
          easing: EASE.out,
        })
      }
    }

    const onMove = (e: PointerEvent) => {
      const s = session.current
      if (!s || e.pointerId !== s.pointerId) return
      s.x = e.clientX
      s.y = e.clientY
      if (!s.active) {
        const dist = Math.hypot(s.x - s.startX, s.y - s.startY)
        if (s.touch) {
          // Moving before the long press completes is a scroll, not a drag.
          if (dist > TOUCH_SLOP) finish(s, false)
        } else if (dist > MOUSE_SLOP) begin(s)
        return
      }
      update(s)
    }
    const onUp = (e: PointerEvent) => {
      const s = session.current
      if (s && e.pointerId === s.pointerId) finish(s, true)
    }
    const onCancel = (e: PointerEvent) => {
      const s = session.current
      if (s && e.pointerId === s.pointerId) finish(s, false)
    }
    const onKey = (e: KeyboardEvent) => {
      const s = session.current
      if (s && e.key === 'Escape') finish(s, false)
    }
    return { begin, finish, onMove, onUp, onCancel, onKey }
  }
  if (!handlers.current) handlers.current = makeHandlers()
  const h = handlers.current

  useEffect(() => {
    // iOS and Chrome only honour preventDefault on a touchmove listener that is registered up front.
    const block = (e: TouchEvent) => {
      if (session.current?.active && e.cancelable) e.preventDefault()
    }
    window.addEventListener('touchmove', block, { passive: false })
    return () => {
      window.removeEventListener('touchmove', block)
      const s = session.current
      if (s) h.finish(s, false)
    }
  }, [h])

  const cardProps = (id: string, from: ProjectStatus) => ({
    'data-card-id': id,
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (!opts.current.enabled || session.current || !e.isPrimary) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if ((e.target as Element).closest('.project-card-menu')) return
      const s: Session = {
        id,
        from,
        el: e.currentTarget,
        pointerId: e.pointerId,
        touch: e.pointerType !== 'mouse',
        startX: e.clientX,
        startY: e.clientY,
        scrollY0: window.scrollY,
        x: e.clientX,
        y: e.clientY,
        active: false,
        timer: undefined,
        raf: 0,
        target: null,
      }
      session.current = s
      if (s.touch) s.timer = setTimeout(() => h.begin(s), PRESS_MS)
      window.addEventListener('pointermove', h.onMove)
      window.addEventListener('pointerup', h.onUp)
      window.addEventListener('pointercancel', h.onCancel)
      window.addEventListener('keydown', h.onKey)
    },
    // A long press on a link opens the browser context menu on touch screens; it would end the drag.
    onContextMenu: (e: { preventDefault: () => void }) => {
      if (session.current?.touch) e.preventDefault()
    },
  })

  return { dragId, target, cardProps }
}
