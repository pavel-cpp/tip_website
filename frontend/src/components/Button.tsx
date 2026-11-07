import type { ComponentProps } from 'react'
import { cx } from '../lib/cx'
import { Tooltip } from './Tooltip'

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'md' | 'sm'
  /** Square icon-only button; pass an aria-label. */
  iconOnly?: boolean
  loading?: boolean
  /** Explains why the button is unavailable. Shown as a tooltip; the button stays focusable. */
  disabledReason?: string
}

/**
 * Unavailable buttons use aria-disabled instead of the disabled attribute so they keep focus
 * and can still show a tooltip explaining why.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  iconOnly,
  loading,
  disabled,
  disabledReason,
  className,
  children,
  onClick,
  type = 'button',
  ...rest
}: ButtonProps) {
  const inert = Boolean(disabled || loading)
  const button = (
    <button
      {...rest}
      type={type}
      className={cx(
        'btn',
        variant !== 'secondary' && `btn-${variant}`,
        size === 'sm' && 'btn-sm',
        iconOnly && 'btn-icon',
        className,
      )}
      aria-disabled={inert || undefined}
      aria-busy={loading || undefined}
      onClick={(e) => {
        if (inert) {
          e.preventDefault()
          return
        }
        onClick?.(e)
      }}
    >
      <span className="btn-content">{children}</span>
      {loading && (
        <span className="btn-spinner" aria-hidden="true">
          <span className="spinner" />
        </span>
      )}
    </button>
  )
  // Stay wrapped even while enabled so toggling `disabled` never remounts the button (and drops focus).
  return disabledReason ? <Tooltip content={inert ? disabledReason : null}>{button}</Tooltip> : button
}
