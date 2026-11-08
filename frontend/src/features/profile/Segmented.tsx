import { type KeyboardEvent, type ReactNode, useId } from 'react'
import './profile.css'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
}

interface Props<T extends string> {
  label: string
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
}

/** Radio group drawn as a segmented control; arrow keys move the selection like native radios. */
export function Segmented<T extends string>({ label, value, options, onChange }: Props<T>) {
  const labelId = useId()
  const move = (e: KeyboardEvent, dir: 1 | -1) => {
    e.preventDefault()
    const i = options.findIndex((o) => o.value === value)
    const next = options[(i + dir + options.length) % options.length]
    if (next) onChange(next.value)
  }
  return (
    <div className="field">
      <span id={labelId} className="field-label">
        {label}
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby={labelId}>
        {options.map((o) => (
          // biome-ignore lint/a11y/useSemanticElements: see above
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            tabIndex={o.value === value ? 0 : -1}
            className="segmented-item"
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(e, 1)
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(e, -1)
            }}
          >
            {o.icon}
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
