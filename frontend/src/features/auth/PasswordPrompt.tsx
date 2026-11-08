import { useState } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { useI18n } from '../../i18n'
import { ChangePasswordForm } from './ChangePasswordForm'

interface Props {
  /** True when the server answered PASSWORD_CHANGE_REQUIRED: postponing is not possible. */
  required: boolean
  onLater: () => void
  onChanged: () => void
}

/** Recommends replacing a temporary password. Dismissible unless the server enforces the change. */
export default function PasswordPrompt({ required, onLater, onChanged }: Props) {
  const { t } = useI18n()
  const { logout } = useAuth()
  const [stage, setStage] = useState<'intro' | 'form'>(required ? 'form' : 'intro')

  const later = (
    <Button variant="ghost" onClick={onLater}>
      {t('auth.prompt.later')}
    </Button>
  )

  return (
    <Modal
      open
      onClose={required ? () => undefined : onLater}
      title={t(required ? 'auth.prompt.requiredTitle' : 'auth.prompt.title')}
      actions={
        stage === 'intro' ? (
          <>
            {later}
            <Button variant="primary" data-autofocus onClick={() => setStage('form')}>
              {t('auth.prompt.now')}
            </Button>
          </>
        ) : undefined
      }
    >
      <p className="muted">{t(required ? 'auth.prompt.requiredBody' : 'auth.prompt.body')}</p>
      {stage === 'form' && (
        <ChangePasswordForm
          onChanged={onChanged}
          extraActions={
            required ? (
              <Button variant="ghost" onClick={() => void logout()}>
                {t('action.signOut')}
              </Button>
            ) : (
              later
            )
          }
        />
      )}
    </Modal>
  )
}
