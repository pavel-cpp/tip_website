import { type CSSProperties, type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from 'react'

export interface TabItem {
  id: string
  label: string
}

interface TabsProps {
  tabs: TabItem[]
  value: string
  onChange: (id: string) => void
  label: string
}

/** Tab list with a sliding underline. Rendering the panel content is the caller's job. */
export function Tabs({ tabs, value, onChange, label }: TabsProps) {
  const base = useId()
  const list = useRef<HTMLDivElement>(null)
  const [bar, setBar] = useState<{ x: number; s: number } | null>(null)

  // Underline = fixed 100px bar moved and stretched with transform only.
  useLayoutEffect(() => {
    const active = list.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (active) setBar({ x: active.offsetLeft, s: active.offsetWidth / 100 })
  }, [value, tabs])

  const onKeyDown = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === value)
    let next = i
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    else return
    e.preventDefault()
    const target = tabs[next]
    if (!target) return
    onChange(target.id)
    list.current?.querySelector<HTMLElement>(`[data-tab="${target.id}"]`)?.focus()
  }

  return (
    <div
      ref={list}
      className="tabs"
      role="tablist"
      aria-label={label}
      data-ready={bar ? 'true' : undefined}
      onKeyDown={onKeyDown}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          data-tab={t.id}
          id={`${base}-${t.id}`}
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          className="tab"
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
      <span
        className="tabs-indicator"
        aria-hidden="true"
        style={bar ? ({ '--x': `${bar.x}px`, '--s': bar.s } as CSSProperties) : undefined}
      />
    </div>
  )
}
