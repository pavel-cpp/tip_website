import { type ReactNode, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { usePresence } from '../lib/motion'
import type { Align, Side } from '../lib/position'
import { useFloating } from '../lib/useFloating'

interface PopoverProps {
  open: boolean
  onClose: () => void
  anchor: HTMLElement | null
  children: ReactNode
  side?: Side
  align?: Align
  role?: string
  label?: string
}

/** Floating panel that scales out of the anchor (origin-aware). Esc and outside press close it. */
export function Popover({
  open,
  onClose,
  anchor,
  children,
  side = 'bottom',
  align = 'end',
  role,
  label,
}: PopoverProps) {
  const { mounted, state } = usePresence(open)
  const { ref, style } = useFloating<HTMLDivElement>(open || mounted, anchor, { side, align })

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
      anchor?.focus()
    }
    const onPress = (e: PointerEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target) || anchor?.contains(target)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPress)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPress)
    }
  }, [open, onClose, anchor, ref])

  if (!mounted) return null
  return createPortal(
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: callers pass a role that supports aria-label (menu)
    <div ref={ref} className="popover" data-state={state} role={role} aria-label={label} style={style}>
      {children}
    </div>,
    document.body,
  )
}
