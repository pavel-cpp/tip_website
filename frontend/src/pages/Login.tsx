import { type FormEvent, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Input, PasswordInput } from '../components/Input'
import '../features/auth/auth.css'
import { useI18n } from '../i18n'
import { errorText } from '../i18n/apiError'
import { cx } from '../lib/cx'
import { prefersReducedMotion } from '../lib/motion'

type Phase = 'idle' | 'loading' | 'done'

/** Where to go after signing in: the page the guard bounced us from, never an absolute URL. */
function returnPath(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/'
}

export default function Login() {
  const { t } = useI18n()
  const { status, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [shaking, setShaking] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [forgot, setForgot] = useState(false)
  const target = returnPath(location.state)

  if (status === 'authenticated' && phase !== 'done') return <Navigate to={target} replace />

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (phase !== 'idle') return
    if (!name.trim() || !password) {
      setError(t('auth.login.fillBoth'))
      setShaking(true)
      return
    }
    setError(null)
    setPhase('loading')
    try {
      await login(name.trim(), password)
      setPhase('done')
      // Let the check mark play before the screen changes.
      setTimeout(
        () => void navigate(target, { replace: true, viewTransition: true }),
        prefersReducedMotion() ? 0 : 450,
      )
    } catch (err) {
      setPhase('idle')
      setError(errorText(err))
      setShaking(true)
    }
  }

  return (
    <div className="login-page">
      <div className="login-backdrop" aria-hidden="true" />
      <form className="login-card" onSubmit={submit} noValidate aria-labelledby="login-title">
        <div className="login-logo" aria-hidden="true">
          <Icon name="lock" size={24} />
        </div>
        <h1 id="login-title" className="login-title">
          {t('app.name')}
        </h1>
        <p className="muted login-subtitle">{t('auth.login.subtitle')}</p>

        <div className={cx('login-fields', shaking && 'shake')} onAnimationEnd={() => setShaking(false)}>
          <Input
            label={t('auth.login.login')}
            icon="user"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-autofocus
          />
          <PasswordInput
            label={t('auth.login.password')}
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && (
          <p className="form-error login-error" role="alert">
            {error}
          </p>
        )}

        <Button
          type="submit"
          variant="primary"
          className="login-submit"
          loading={phase === 'loading'}
          data-phase={phase}
        >
          {phase === 'done' ? <Icon name="check" className="check-pop" /> : <Icon name="arrowRight" />}
          {t('auth.login.submit')}
        </Button>

        <div className="login-foot">
          <span className="muted">{t('auth.login.footer')}</span>
          <button
            type="button"
            className="link-btn"
            aria-expanded={forgot}
            aria-controls="login-forgot"
            onClick={() => setForgot((v) => !v)}
          >
            {t('auth.login.forgot')}
          </button>
        </div>
        {forgot && (
          <p id="login-forgot" className="login-hint" role="status">
            <Icon name="info" />
            {t('auth.login.forgotHint')}
          </p>
        )}
      </form>
    </div>
  )
}
