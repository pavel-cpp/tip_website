import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { DURATION, prefersReducedMotion } from '../lib/motion'
import { Button } from './Button'

export interface ToastOptions {
  message: string
  tone?: 'info' | 'error'
  /** Shown as a button until the timer ends, e.g. Undo. */
  action?: { label: string; onAction: () => void }
  /** A second button after `action`, e.g. "Show" next to "Undo". */
  secondaryAction?: { label: string; onAction: () => void }
  /** Milliseconds before auto-dismiss. Defaults to 5000. */
  duration?: number
}

interface ToastEntry extends ToastOptions {
  id: number
  closing: boolean
}

interface ToastApi {
  show: (options: ToastOptions) => number
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastApi | null>(null)
const MAX_VISIBLE = 3

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, closing: true } : t)))
    // Leave the element mounted while the exit animation runs.
    setTimeout(
      () => setToasts((list) => list.filter((t) => t.id !== id)),
      prefersReducedMotion() ? 0 : DURATION.fast,
    )
  }, [])

  const show = useCallback((options: ToastOptions) => {
    const id = nextId.current++
    setToasts((list) => [...list, { ...options, id, closing: false }].slice(-MAX_VISIBLE))
    return id
  }, [])

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="toast-region" role="status" aria-live="polite">
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}

function ToastItem({ toast, onDismiss }: { toast: ToastEntry; onDismiss: () => void }) {
  const duration = toast.duration ?? 5000
  const [paused, setPaused] = useState(false)
  const remaining = useRef(duration)

  // Hover or keyboard focus pauses both this timer and the CSS timer bar.
  useEffect(() => {
    if (paused || toast.closing) return
    const started = Date.now()
    const id = setTimeout(onDismiss, remaining.current)
    return () => {
      clearTimeout(id)
      remaining.current -= Date.now() - started
    }
  }, [paused, toast.closing, onDismiss])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer/focus only pause the timer, the toast has no action of its own
    <div
      className="toast"
      data-state={toast.closing ? 'closed' : 'open'}
      data-tone={toast.tone ?? 'info'}
      // Failures interrupt (assertive); confirmations stay polite inside the region.
      role={toast.tone === 'error' ? 'alert' : undefined}
      data-paused={paused || undefined}
      style={{ '--toast-ms': `${duration}ms` } as CSSProperties}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span>{toast.message}</span>
      {[toast.action, toast.secondaryAction].map(
        (a) =>
          a && (
            <Button
              key={a.label}
              variant="ghost"
              size="sm"
              className="toast-action"
              onClick={() => {
                a.onAction()
                onDismiss()
              }}
            >
              {a.label}
            </Button>
          ),
      )}
      <span className="toast-bar" aria-hidden="true" />
    </div>
  )
}
