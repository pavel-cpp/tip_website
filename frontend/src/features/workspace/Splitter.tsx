import { type KeyboardEvent, type PointerEvent, type RefObject, useRef } from 'react'
import { useI18n } from '../../i18n'
import { WsIcon, type WsIconName } from './icons'
import {
  arrowAction,
  type Collapsed,
  clampRatio,
  MAX_RATIO,
  MIN_RATIO,
  nudgeRatio,
  ratioFromPointer,
  type Side,
} from './split'

export const HANDLE_PX = 16

interface SplitterProps {
  orientation: 'horizontal' | 'vertical'
  ratio: number
  collapsed: Collapsed
  /** The grid the handle sits in; the pointer position is measured against it. */
  gridRef: RefObject<HTMLElement | null>
  names: { first: string; second: string }
  onRatio: (ratio: number) => void
  onDragging: (dragging: boolean) => void
  onArrow: (side: Side) => void
  onReset: () => void
}

/**
 * Handle between the two work panels. A drag, the arrow keys and a double click resize it; the two
 * small arrows hide a panel, and stay on the edge to bring it back.
 */
export function Splitter({
  orientation,
  ratio,
  collapsed,
  gridRef,
  names,
  onRatio,
  onDragging,
  onArrow,
  onReset,
}: SplitterProps) {
  const { t } = useI18n()
  const horizontal = orientation === 'horizontal'
  const drag = useRef(false)

  const move = (e: PointerEvent<HTMLElement>) => {
    const grid = gridRef.current
    if (!drag.current || !grid) return
    const r = grid.getBoundingClientRect()
    onRatio(
      horizontal
        ? ratioFromPointer(e.clientX, r.left, r.width, HANDLE_PX)
        : ratioFromPointer(e.clientY, r.top, r.height, HANDLE_PX),
    )
  }
  const end = (e: PointerEvent<HTMLElement>) => {
    if (!drag.current) return
    drag.current = false
    onDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const start = (e: PointerEvent<HTMLElement>) => {
    if (collapsed || e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    drag.current = true
    onDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const back = horizontal ? 'ArrowLeft' : 'ArrowUp'
    const fwd = horizontal ? 'ArrowRight' : 'ArrowDown'
    if (collapsed) return
    if (e.key === back || e.key === fwd) {
      e.preventDefault()
      onRatio(nudgeRatio(ratio, e.key === back ? -1 : 1, e.shiftKey))
    } else if (e.key === 'Home' || e.key === 'Enter') {
      e.preventDefault()
      onReset()
    }
  }

  const arrow = (side: Side) => {
    const act = arrowAction(collapsed, side)
    if (!act) return null
    // The panel an arrow points at is the one it hides; when the other one is hidden it shows that one.
    const target = act === 'hide' ? side : side === 'first' ? 'second' : 'first'
    const icon: WsIconName = horizontal
      ? side === 'first'
        ? 'chevronLeft'
        : 'chevronRight'
      : side === 'first'
        ? 'chevronUp'
        : 'chevronDown'
    return (
      <button
        key={side}
        type="button"
        className="ws-split-arrow"
        data-side={side}
        aria-label={t(act === 'hide' ? 'workspace.split.hide' : 'workspace.split.show', {
          name: names[target],
        })}
        title={t(act === 'hide' ? 'workspace.split.hide' : 'workspace.split.show', { name: names[target] })}
        onClick={() => onArrow(side)}
      >
        <WsIcon name={icon} size={18} />
      </button>
    )
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: the WAI-ARIA window splitter is a focusable separator with a value; <hr> can be neither
    <div
      role="separator"
      tabIndex={collapsed ? -1 : 0}
      className="ws-split"
      data-orientation={orientation}
      data-collapsed={collapsed ?? undefined}
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-label={t('workspace.split.label')}
      aria-valuemin={Math.round(MIN_RATIO * 100)}
      aria-valuemax={Math.round(MAX_RATIO * 100)}
      aria-valuenow={Math.round(clampRatio(ratio) * 100)}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKey}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest('button')) onReset()
      }}
    >
      <span className="ws-split-grip" aria-hidden="true" />
      <span className="ws-split-arrows">
        {arrow('first')}
        {arrow('second')}
      </span>
    </div>
  )
}
