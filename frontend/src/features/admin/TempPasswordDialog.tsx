import { useEffect, useState } from 'react'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { useI18n } from '../../i18n'
import './admin.css'

interface Props {
  /** The generated password; null keeps the dialog closed. It exists only in this component's props. */
  password: string | null
  /** Display name of the user the password belongs to. */
  userName: string
  reset?: boolean
  onClose: () => void
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Shows a server-generated temporary password once; it cannot be retrieved again after closing. */
export function TempPasswordDialog({ password, userName, reset = false, onClose }: Props) {
  const { t } = useI18n()
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle')

  // A new password starts with a clean "not copied yet" state.
  useEffect(() => {
    if (password) setCopied('idle')
  }, [password])

  // Keep the last password while the exit animation plays.
  const [shown, setShown] = useState(password)
  useEffect(() => {
    if (password) {
      setShown(password)
      return
    }
    // Forget the secret once the modal has finished closing.
    const id = setTimeout(() => setShown(null), 400)
    return () => clearTimeout(id)
  }, [password])

  return (
    <Modal
      open={password !== null}
      // Esc and a backdrop press must not lose the one-time secret: only the explicit button closes it.
      onClose={() => undefined}
      title={t(reset ? 'admin.users.resetDoneTitle' : 'admin.users.createdTitle')}
      actions={
        <Button variant="primary" onClick={onClose}>
          {t('admin.users.passwordSaved')}
        </Button>
      }
    >
      <p>{t(reset ? 'admin.users.resetDoneBody' : 'admin.users.createdBody', { name: userName })}</p>
      <div className="temp-password">
        {/* A read-only input keeps the secret selectable and gives it an accessible name. */}
        <input
          readOnly
          className="temp-password-value"
          aria-label={t('admin.users.tempPassword')}
          autoComplete="off"
          spellCheck={false}
          value={shown ?? ''}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          size="sm"
          data-autofocus
          onClick={async () => setCopied((await copyText(shown ?? '')) ? 'ok' : 'failed')}
        >
          {copied === 'ok' ? <Icon name="check" className="check-pop" /> : null}
          {t(copied === 'ok' ? 'admin.users.copied' : 'admin.users.copy')}
        </Button>
      </div>
      {copied === 'failed' && (
        <p className="form-error" role="alert">
          {t('admin.users.copyFailed')}
        </p>
      )}
      <p className="notice" role="note">
        <Icon name="alert" />
        {t('admin.users.onceNotice')}
      </p>
    </Modal>
  )
}
