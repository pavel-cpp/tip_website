import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { isApiError } from '../../api/errors'
import { useAuth } from '../../auth/AuthProvider'
import { changePasswordRequest } from '../../auth/session'
import { Button } from '../../components/Button'
import { PasswordInput } from '../../components/Input'
import { useToast } from '../../components/Toast'
import { useI18n } from '../../i18n'
import { errorText } from '../../i18n/apiError'
import './auth.css'

export const MIN_PASSWORD_LENGTH = 8

interface Props {
  onChanged?: () => void
  /** Extra buttons rendered next to the submit button (e.g. "Remind me later"). */
  extraActions?: ReactNode
}

/** Shared by the profile screen and the "change your temporary password" prompt. */
export function ChangePasswordForm({ onChanged, extraActions }: Props) {
  const { t } = useI18n()
  const toast = useToast()
  const { reloadUser } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [errors, setErrors] = useState<{ current?: string; next?: string; repeat?: string; form?: string }>(
    {},
  )
  const [busy, setBusy] = useState(false)
  const formId = useId()

  async function submit(e: FormEvent) {
    e.preventDefault()
    const found: typeof errors = {}
    if (!current) found.current = t('validation.required')
    if (next.length < MIN_PASSWORD_LENGTH)
      found.next = t('validation.minLength', { count: MIN_PASSWORD_LENGTH })
    if (repeat !== next) found.repeat = t('validation.passwordMismatch')
    setErrors(found)
    if (Object.keys(found).length > 0) return

    setBusy(true)
    try {
      await changePasswordRequest(current, next)
      setCurrent('')
      setNext('')
      setRepeat('')
      toast.show({ message: t('auth.password.changed') })
      await reloadUser().catch(() => undefined)
      onChanged?.()
    } catch (err) {
      // A wrong current password is reported as BAD_CREDENTIALS or VALIDATION depending on the server path.
      if (isApiError(err) && (err.code === 'BAD_CREDENTIALS' || err.code === 'VALIDATION')) {
        setErrors({ current: t('auth.password.currentWrong') })
      } else {
        setErrors({ form: errorText(err) })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="pw-form" onSubmit={submit} noValidate aria-labelledby={`${formId}-title`}>
      <span id={`${formId}-title`} className="sr-only">
        {t('auth.password.title')}
      </span>
      <PasswordInput
        label={t('auth.password.current')}
        name="current-password"
        autoComplete="current-password"
        value={current}
        error={errors.current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <div className="pw-form-pair">
        <PasswordInput
          label={t('auth.password.new')}
          name="new-password"
          autoComplete="new-password"
          placeholder={t('validation.minLength', { count: MIN_PASSWORD_LENGTH })}
          value={next}
          error={errors.next}
          onChange={(e) => setNext(e.target.value)}
        />
        <PasswordInput
          label={t('auth.password.repeat')}
          name="repeat-password"
          autoComplete="new-password"
          placeholder={t('auth.password.repeatHint')}
          value={repeat}
          error={errors.repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
      </div>
      {errors.form && (
        <p className="form-error" role="alert">
          {errors.form}
        </p>
      )}
      <div className="pw-form-actions">
        {extraActions}
        <Button type="submit" variant="primary" loading={busy}>
          {t('auth.password.submit')}
        </Button>
      </div>
    </form>
  )
}
