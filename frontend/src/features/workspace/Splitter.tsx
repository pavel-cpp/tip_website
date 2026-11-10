import { type KeyboardEvent, type PointerEvent, type RefObject, useRef } from 'react'
import { useI18n } from '../../i18n'
import {
  clampRatio,
  DEFAULT_SPLIT,
  dragState,
  handleRatio,
  hideSide,
  liveTracks,
  nudgeState,
  ratioFromPointer,
  type SplitState,
  tracks,
} from './split'

export const HANDLE_PX = 16
/** Pointer travel (px) below which a press on a hidden panel's edge counts as a click, not a drag. */
const CLICK_SLOP = 4

interface SplitterProps {
  orientation: 'horizontal' | 'vertical'
  split: SplitState
  /** The grid the handle sits in; it is measured and, while dragging, driven directly (no React renders). */
  gridRef: RefObject<HTMLElement | null>
  names: { first: string; second: string }
  onSplit: (update: (prev: SplitState) => SplitState) => void
}

interface Drag {
  /** Pointer position at the press, and where the handle centre was: the panel follows the pointer 1:1. */
  from: number
  grab: number
  moved: boolean
  raw: number
  frame: number
}

/**
 * Handle between the two work panels. While it is dragged the panel size follows the pointer 1:1 through a CSS
 * variable on the grid (one write per frame, no React render); past the hide point the panel that would hide
 * dims ("release to hide"). On release the grid eases to the settled size, or hides the panel. A hidden panel
 * comes back by dragging the handle out again, by a click, or with the arrow keys.
 */
export function Splitter({ orientation, split, gridRef, names, onSplit }: SplitterProps) {
  const { t } = useI18n()
  const horizontal = orientation === 'horizontal'
  const { ratio, collapsed } = split
  const drag = useRef<Drag | null>(null)

  const pos = (e: PointerEvent<HTMLElement>) => (horizontal ? e.clientX : e.clientY)

  const apply = (d: Drag) => {
    d.frame = 0
    const grid = gridRef.current
    if (!grid) return
    grid.style.setProperty('--ws-tracks', liveTracks(d.raw, HANDLE_PX))
    const side = hideSide(d.raw, split.collapsed)
    if (side) grid.dataset.hide = side
    else delete grid.dataset.hide
  }
  const rawAt = (e: PointerEvent<HTMLElement>, d: Drag): number => {
    const grid = gridRef.current
    if (!grid) return d.raw
    const r = grid.getBoundingClientRect()
    return horizontal
      ? ratioFromPointer(e.clientX - d.grab, r.left, r.width, HANDLE_PX)
      : ratioFromPointer(e.clientY - d.grab, r.top, r.height, HANDLE_PX)
  }

  const start = (e: PointerEvent<HTMLElement>) => {
    const grid = gridRef.current
    if (e.button !== 0 || !grid) return
    const box = e.currentTarget.getBoundingClientRect()
    const centre = horizontal ? box.left + box.width / 2 : box.top + box.height / 2
    drag.current = { from: pos(e), grab: pos(e) - centre, moved: false, raw: handleRatio(split), frame: 0 }
    grid.dataset.dragging = ''
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.abs(pos(e) - d.from) < CLICK_SLOP) return
    d.moved = true
    d.raw = rawAt(e, d)
    if (!d.frame) d.frame = requestAnimationFrame(() => apply(d))
  }
  const end = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current
    const grid = gridRef.current
    if (!d) return
    drag.current = null
    cancelAnimationFrame(d.frame)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (!grid) return
    // A plain click on the edge of a hidden panel opens it.
    const next: SplitState =
      !d.moved && split.collapsed
        ? { ratio: split.ratio, collapsed: null }
        : d.moved && e.type === 'pointerup'
          ? dragState(d.raw, split)
          : split
    // The same string React writes on the commit below, so the grid never shows a stale live value; the
    // transition (back on once data-dragging is gone) eases from where the pointer left it to the settled size.
    grid.style.setProperty('--ws-tracks', tracks(next, HANDLE_PX))
    delete grid.dataset.dragging
    delete grid.dataset.hide
    onSplit(() => next)
  }
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const back = horizontal ? 'ArrowLeft' : 'ArrowUp'
    const fwd = horizontal ? 'ArrowRight' : 'ArrowDown'
    if (e.key === back || e.key === fwd) {
      e.preventDefault()
      // The picture-only ticket stepping listens to the arrows too; a focused handle keeps them.
      e.stopPropagation()
      onSplit((prev) => nudgeState(prev, e.key === back ? -1 : 1, e.shiftKey))
    } else if (e.key === 'Home' || e.key === 'Enter') {
      e.preventDefault()
      onSplit(() => DEFAULT_SPLIT)
    }
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: the WAI-ARIA window splitter is a focusable separator with a value; <hr> can be neither
    <div
      role="separator"
      tabIndex={0}
      className="ws-split"
      data-orientation={orientation}
      data-collapsed={collapsed ?? undefined}
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-label={t('workspace.split.label')}
      title={collapsed ? t('workspace.split.show', { name: names[collapsed] }) : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={
        collapsed === 'first' ? 0 : collapsed === 'second' ? 100 : Math.round(clampRatio(ratio) * 100)
      }
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKey}
      onDoubleClick={() => onSplit(() => DEFAULT_SPLIT)}
    >
      <span className="ws-split-grip" aria-hidden="true" />
      <span className="ws-split-dots" aria-hidden="true" />
    </div>
  )
}
