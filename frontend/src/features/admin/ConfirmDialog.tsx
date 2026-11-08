import type { ReactNode } from 'react'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { useI18n } from '../../i18n'

interface Props {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}

/** Confirmation for actions that cannot be undone (reset password, delete role). */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: Props) {
  const { t } = useI18n()
  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={title}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('action.cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  )
}
