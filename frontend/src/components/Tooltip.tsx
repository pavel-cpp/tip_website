import { cloneElement, type ReactElement, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useFloating } from '../lib/useFloating'

interface TooltipProps {
  content: ReactNode
  /** A single element; it receives aria-describedby while the tooltip is open. */
  children: ReactElement<{ 'aria-describedby'?: string }>
  side?: 'top' | 'bottom'
}

const HOVER_DELAY = 300
const TOUCH_HIDE = 2500

/** Hover/focus on desktop, tap on touch devices. Esc or an outside tap dismisses it. */
export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  const id = useId()
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null)
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const { ref, style } = useFloating<HTMLDivElement>(open, anchor, { side, align: 'center' })

  const clear = () => clearTimeout(timer.current)
  useEffect(() => clear, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    const onOutside = (e: PointerEvent) => !anchor?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onOutside)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onOutside)
    }
  }, [open, anchor])

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only observes pointer/focus events bubbling from its interactive child */}
      <span
        ref={setAnchor}
        className="tooltip-anchor"
        onPointerEnter={(e) => {
          if (e.pointerType === 'touch') return
          clear()
          timer.current = setTimeout(() => setOpen(true), HOVER_DELAY)
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'touch') return
          clear()
          setOpen(false)
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch') return
          clear()
          setOpen((v) => !v)
          timer.current = setTimeout(() => setOpen(false), TOUCH_HIDE)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {cloneElement(children, { 'aria-describedby': open ? id : undefined })}
      </span>
      {open &&
        content &&
        createPortal(
          <div ref={ref} id={id} role="tooltip" className="tooltip" style={style}>
            {content}
          </div>,
          document.body,
        )}
    </>
  )
}
