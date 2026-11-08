import { useMutation } from '@tanstack/react-query'
import { type FormEvent, useEffect, useState } from 'react'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { Input } from '../../components/Input'
import { Modal } from '../../components/Modal'
import { useI18n } from '../../i18n'
import { errorText } from '../../i18n/apiError'
import { createRole, type Permission, type PermissionCode, type Role, updateRole } from './api'
import { PermissionMatrix } from './PermissionMatrix'

const FORM_ID = 'role-editor-form'

/** The admin role always holds every permission and cannot be edited (ROLE_SYSTEM). */
export function isLockedRole(role: Role): boolean {
  return role.isSystem && role.name === 'admin'
}

interface Props {
  /** A role to edit, 'new' to create one, null to stay closed. */
  target: Role | 'new' | null
  catalog: Permission[]
  onClose: () => void
  onSaved: () => void
}

export function RoleEditor({ target, catalog, onClose, onSaved }: Props) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [perms, setPerms] = useState<ReadonlySet<PermissionCode>>(new Set())
  const [nameError, setNameError] = useState<string>()
  const [formError, setFormError] = useState<string>()
  // Keeps the title and read-only state stable while the dialog fades out.
  const [shown, setShown] = useState<Role | 'new'>('new')

  useEffect(() => {
    if (target === null) return
    setShown(target)
    setName(target === 'new' ? '' : target.name)
    setDescription(target === 'new' ? '' : target.description)
    setPerms(new Set(target === 'new' ? [] : target.permissions))
    setNameError(undefined)
    setFormError(undefined)
  }, [target])

  const locked = shown !== 'new' && isLockedRole(shown)

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description: description.trim(), permissions: [...perms] }
      return shown === 'new' ? createRole(body) : updateRole(shown.id, body)
    },
    onSuccess: onSaved,
    onError: (err) => setFormError(errorText(err)),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (locked) return
    if (!name.trim()) {
      setNameError(t('validation.required'))
      return
    }
    setNameError(undefined)
    setFormError(undefined)
    save.mutate()
  }

  return (
    <Modal
      open={target !== null}
      onClose={save.isPending ? () => undefined : onClose}
      title={t(
        shown === 'new'
          ? 'admin.roles.createTitle'
          : locked
            ? 'admin.roles.viewTitle'
            : 'admin.roles.editTitle',
      )}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            {t(locked ? 'action.close' : 'action.cancel')}
          </Button>
          {!locked && (
            <Button type="submit" form={FORM_ID} variant="primary" loading={save.isPending}>
              {t('action.save')}
            </Button>
          )}
        </>
      }
    >
      <form id={FORM_ID} className="dialog-form role-editor" onSubmit={submit} noValidate>
        {locked && (
          <p className="notice" role="note">
            <Icon name="lock" />
            {t('admin.roles.lockedNotice')}
          </p>
        )}
        <Input
          label={t('admin.roles.name')}
          name="name"
          autoComplete="off"
          value={name}
          error={nameError}
          readOnly={locked}
          data-autofocus
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          label={t('admin.roles.description')}
          name="description"
          autoComplete="off"
          value={description}
          readOnly={locked}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="matrix-head">
          <span className="field-label">{t('admin.roles.permissions')}</span>
          <span className="perm-count" aria-live="polite">
            <span key={perms.size} className="count-roll">
              {perms.size}
            </span>
            {` / ${catalog.length}`}
          </span>
        </div>
        <PermissionMatrix catalog={catalog} value={perms} onChange={setPerms} readOnly={locked} />
        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}
      </form>
    </Modal>
  )
}
