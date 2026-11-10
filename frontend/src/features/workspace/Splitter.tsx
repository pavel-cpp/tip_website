import { type KeyboardEvent, type PointerEvent, type RefObject, useRef } from 'react'
import { useI18n } from '../../i18n'
import { clampRatio, DEFAULT_SPLIT, dragState, nudgeState, ratioFromPointer, type SplitState } from './split'

export const HANDLE_PX = 16
/** Pointer travel (px) below which a press on a hidden panel's edge counts as a click, not a drag. */
const CLICK_SLOP = 4

interface SplitterProps {
  orientation: 'horizontal' | 'vertical'
  split: SplitState
  /** The grid the handle sits in; the pointer position is measured against it. */
  gridRef: RefObject<HTMLElement | null>
  names: { first: string; second: string }
  onSplit: (update: (prev: SplitState) => SplitState) => void
  onDragging: (dragging: boolean) => void
}

/**
 * Handle between the two work panels. Dragging it resizes them; dragging it to an edge hides the panel
 * on that side, and the same handle (drag back, click, or the arrow keys) brings it back.
 */
export function Splitter({ orientation, split, gridRef, names, onSplit, onDragging }: SplitterProps) {
  const { t } = useI18n()
  const horizontal = orientation === 'horizontal'
  const { ratio, collapsed } = split
  const drag = useRef<{ from: number; moved: boolean } | null>(null)

  const pos = (e: PointerEvent<HTMLElement>) => (horizontal ? e.clientX : e.clientY)
  const move = (e: PointerEvent<HTMLElement>) => {
    const grid = gridRef.current
    const d = drag.current
    if (!d || !grid) return
    if (!d.moved && Math.abs(pos(e) - d.from) < CLICK_SLOP) return
    d.moved = true
    const r = grid.getBoundingClientRect()
    const raw = horizontal
      ? ratioFromPointer(e.clientX, r.left, r.width, HANDLE_PX)
      : ratioFromPointer(e.clientY, r.top, r.height, HANDLE_PX)
    onSplit((prev) => dragState(raw, prev))
  }
  const end = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    onDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    // A plain click on the edge of a hidden panel opens it.
    if (!d.moved && collapsed && e.type === 'pointerup')
      onSplit((prev) => ({ ratio: prev.ratio, collapsed: null }))
  }
  const start = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    drag.current = { from: pos(e), moved: false }
    onDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const back = horizontal ? 'ArrowLeft' : 'ArrowUp'
    const fwd = horizontal ? 'ArrowRight' : 'ArrowDown'
    if (e.key === back || e.key === fwd) {
      e.preventDefault()
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
    </div>
  )
}
