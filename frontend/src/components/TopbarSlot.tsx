import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import '../features/workspace/workspace-topbar.css'
import { AppLink } from './AppLink'

export interface Crumb {
  label: string
  /** Omit for the current page (rendered as plain text). */
  to?: string
}

interface SlotValue {
  slot: HTMLElement | null
  setSlot: (el: HTMLElement | null) => void
  crumbs: Crumb[]
  setCrumbs: (c: Crumb[]) => void
}

const SlotContext = createContext<SlotValue | null>(null)

/** Lets a page put its own content (project path, online users) into the persistent top bar. */
export function TopbarSlotProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [crumbs, setCrumbs] = useState<Crumb[]>([])
  return <SlotContext.Provider value={{ slot, setSlot, crumbs, setCrumbs }}>{children}</SlotContext.Provider>
}

/** The element in the top bar that grows to fill the space between the brand and the menus. */
export function TopbarSlotTarget() {
  const ctx = useContext(SlotContext)
  return (
    <div className="topbar-slot" ref={ctx?.setSlot}>
      {ctx && ctx.crumbs.length > 0 && <CrumbTrail crumbs={ctx.crumbs} />}
    </div>
  )
}

function CrumbTrail({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav className="wsbar-crumbs" aria-label="breadcrumb">
      {crumbs.map((c, i) => (
        <span className="wsbar-crumb" key={`${c.to ?? ''}|${c.label}`}>
          {i > 0 && (
            <span className="muted wsbar-slash" aria-hidden="true">
              /
            </span>
          )}
          {c.to ? (
            <AppLink to={c.to} className="muted wsbar-parent">
              {c.label}
            </AppLink>
          ) : (
            <span className="wsbar-title" aria-current="page">
              {c.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  )
}

/**
 * Shows a breadcrumb trail in the top bar for as long as the calling page is mounted, e.g.
 * `useTopbarCrumbs([{ label: 'Projects', to: '/' }, { label: title, to: `/projects/${id}` }, { label: 'Settings' }])`.
 * Pass an empty array while data is loading. The last crumb should have no `to`.
 */
export function useTopbarCrumbs(crumbs: Crumb[]): void {
  const setCrumbs = useContext(SlotContext)?.setCrumbs
  const key = JSON.stringify(crumbs)
  useEffect(() => {
    setCrumbs?.(JSON.parse(key) as Crumb[])
    return () => setCrumbs?.([])
  }, [key, setCrumbs])
}

/** Renders `children` inside the top bar, or inline through `fallback` where there is no top bar (tests). */
export function TopbarPortal({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  const slot = useContext(SlotContext)?.slot ?? null
  if (slot) return createPortal(children, slot)
  return fallback ?? null
}
