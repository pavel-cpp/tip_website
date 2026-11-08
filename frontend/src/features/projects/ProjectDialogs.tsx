import { type FormEvent, useEffect, useState } from 'react'
import { Button } from '../../components/Button'
import { Input } from '../../components/Input'
import { Modal } from '../../components/Modal'
import { useI18n } from '../../i18n'
import { errorText } from '../../i18n/apiError'
import { deleteConfirmed } from './logic'

interface CreateProps {
  open: boolean
  onClose: () => void
  onCreate: (title: string) => Promise<unknown>
}

export function CreateProjectDialog({ open, onClose, onCreate }: CreateProps) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (open) {
      setTitle('')
      setError(undefined)
    }
  }, [open])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) {
      setError(t('validation.required'))
      return
    }
    setBusy(true)
    try {
      await onCreate(title.trim())
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('projects.create.title')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="create-project-form" loading={busy}>
            {t('projects.create.submit')}
          </Button>
        </>
      }
    >
      <form id="create-project-form" onSubmit={submit}>
        <Input
          data-autofocus
          name="title"
          label={t('projects.create.name')}
          value={title}
          maxLength={200}
          autoComplete="off"
          error={error}
          onChange={(e) => {
            setTitle(e.target.value)
            setError(undefined)
          }}
        />
      </form>
    </Modal>
  )
}

interface DeleteProps {
  /** The title to retype, or null when the dialog is closed. */
  title: string | null
  onClose: () => void
  onDelete: () => Promise<unknown>
}

/** The only confirmation in the screen: deletion is irreversible, so the title must be typed. */
export function DeleteProjectDialog({ title, onClose, onDelete }: DeleteProps) {
  const { t } = useI18n()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [last, setLast] = useState(title ?? '')

  useEffect(() => {
    if (title !== null) {
      setLast(title)
      setTyped('')
      setError(undefined)
      setBusy(false)
    }
  }, [title])

  const ok = deleteConfirmed(typed, last)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ok) return
    setBusy(true)
    try {
      await onDelete()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Modal
      open={title !== null}
      onClose={onClose}
      title={t('projects.delete.title')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button variant="danger" type="submit" form="delete-project-form" loading={busy} disabled={!ok}>
            {t('projects.delete.submit')}
          </Button>
        </>
      }
    >
      <form id="delete-project-form" onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <p className="muted">{t('projects.delete.body', { title: last })}</p>
        <Input
          data-autofocus
          name="confirm"
          label={t('projects.delete.confirm')}
          value={typed}
          autoComplete="off"
          error={error}
          onChange={(e) => {
            setTyped(e.target.value)
            setError(undefined)
          }}
        />
      </form>
    </Modal>
  )
}
