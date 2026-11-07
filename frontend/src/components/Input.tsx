import { type ComponentProps, type ReactNode, useId, useState } from 'react'
import { useI18n } from '../i18n'
import { cx } from '../lib/cx'
import { Icon, type IconName } from './Icon'

export interface InputProps extends ComponentProps<'input'> {
  label: string
  hint?: string
  error?: string
  icon?: IconName
  /** Extra content after the input, inside the field frame. */
  trailing?: ReactNode
}

export function Input({ label, hint, error, icon, trailing, id, className, ...rest }: InputProps) {
  const auto = useId()
  const inputId = id ?? auto
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`
  const describedBy = [error && errorId, hint && hintId].filter(Boolean).join(' ') || undefined

  return (
    <div className={cx('field', className)}>
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="input" data-invalid={error ? 'true' : undefined}>
        {icon && <Icon name={icon} />}
        <input
          {...rest}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
        {trailing}
      </div>
      {error && (
        <span id={errorId} className="field-error" role="alert">
          {error}
        </span>
      )}
      {hint && !error && (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      )}
    </div>
  )
}

/** Password field with a show/hide toggle; the two eye icons cross-fade instead of swapping. */
export function PasswordInput(props: Omit<InputProps, 'type' | 'trailing'>) {
  const { t } = useI18n()
  const [visible, setVisible] = useState(false)
  return (
    <Input
      icon="lock"
      autoComplete="current-password"
      {...props}
      type={visible ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          className="eye-toggle"
          aria-pressed={visible}
          aria-label={visible ? t('action.hidePassword') : t('action.showPassword')}
          onClick={() => setVisible((v) => !v)}
        >
          <Icon name="eye" className="eye-on" />
          <Icon name="eyeOff" className="eye-off" />
        </button>
      }
    />
  )
}
