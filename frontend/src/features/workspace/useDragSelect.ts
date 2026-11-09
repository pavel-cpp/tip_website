import { useCallback, useEffect, useRef } from 'react'
import { autoScrollStep, rangeSelection, rowIndexAt } from './tableLogic'

interface Drag {
  startRow: number
  base: ReadonlySet<string>
  end: number
  x: number
  y: number
  raf: number
}

interface Options {
  scroller: React.RefObject<HTMLElement | null>
  /** Row ids in display order. */
  ids: readonly string[]
  rowHeight: number
  onSelect: (selected: ReadonlySet<string>) => void
}

/**
 * Mouse drag selection over the virtualized rows. The row under the pointer is computed from the
 * pointer position and the fixed row height (not from the DOM), so it works for rows that are not
 * rendered; near the top or bottom edge the list scrolls on its own while the pointer is held.
 * Returns `begin`, to call from a pointerdown on a cell, and `consumed`, which tells the following
 * click handler that the gesture was already handled here.
 */
export function useDragSelect({ scroller, ids, rowHeight, onSelect }: Options) {
  const latest = useRef({ ids, rowHeight, onSelect })
  latest.current = { ids, rowHeight, onSelect }
  const drag = useRef<Drag | null>(null)
  const handled = useRef(false)
  const stop = useRef<(() => void) | null>(null)

  const update = useCallback(() => {
    const d = drag.current
    const el = scroller.current
    if (!d || !el) return
    const { ids, rowHeight, onSelect } = latest.current
    const rect = el.getBoundingClientRect()
    const row = rowIndexAt(d.y, rect.top, el.scrollTop, rowHeight, ids.length)
    if (row < 0 || row === d.end) return
    d.end = row
    onSelect(rangeSelection(ids, d.startRow, row, d.base))
  }, [scroller])

  const begin = useCallback(
    (e: { clientX: number; clientY: number }, startRow: number, base: ReadonlySet<string>) => {
      stop.current?.()
      handled.current = true
      const d: Drag = { startRow, base, end: startRow, x: e.clientX, y: e.clientY, raf: 0 }
      drag.current = d

      const tick = () => {
        const el = scroller.current
        if (el) {
          const rect = el.getBoundingClientRect()
          const step = autoScrollStep(d.y, rect.top, rect.bottom)
          if (step !== 0) {
            el.scrollTop += step
            update()
          }
        }
        d.raf = requestAnimationFrame(tick)
      }
      const move = (ev: PointerEvent) => {
        d.x = ev.clientX
        d.y = ev.clientY
        update()
      }
      const end = () => {
        cancelAnimationFrame(d.raf)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        drag.current = null
        stop.current = null
        // The click that follows the release comes in the same task; clear the flag after it.
        setTimeout(() => {
          handled.current = false
        }, 0)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
      stop.current = end
      d.raf = requestAnimationFrame(tick)
    },
    [scroller, update],
  )

  useEffect(() => () => stop.current?.(), [])

  /** True once for the click that follows a mouse gesture this hook already handled. */
  const consumed = useCallback(() => {
    const was = handled.current
    handled.current = false
    return was
  }, [])

  return { begin, consumed }
}
