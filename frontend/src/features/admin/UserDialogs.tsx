import { useMutation } from '@tanstack/react-query'
import { type FormEvent, useEffect, useState } from 'react'
import { isApiError } from '../../api/errors'
import { Button } from '../../components/Button'
import { Input } from '../../components/Input'
import { Modal } from '../../components/Modal'
import { useToast } from '../../components/Toast'
import { useI18n } from '../../i18n'
import { errorText } from '../../i18n/apiError'
import { type AdminUser, createUser, type Role, setUserRoles } from './api'
import { RoleChecklist } from './RoleChecklist'

const FORM_ID = 'create-user-form'

interface CreateProps {
  open: boolean
  /** Roles can only be chosen with role.manage; otherwise the server assigns the default role. */
  roles: Role[] | null
  onClose: () => void
  onCreated: (result: { user: AdminUser['user']; tempPassword: string }) => void
}

export function CreateUserDialog({ open, roles, onClose, onCreated }: CreateProps) {
  const { t } = useI18n()
  const [login, setLogin] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [errors, setErrors] = useState<{ login?: string; displayName?: string; form?: string }>({})

  useEffect(() => {
    if (!open) return
    setLogin('')
    setDisplayName('')
    setPicked(new Set())
    setErrors({})
  }, [open])

  const create = useMutation({
    mutationFn: () =>
      createUser({
        login: login.trim(),
        displayName: displayName.trim(),
        roleIds: roles && picked.size > 0 ? [...picked] : undefined,
      }),
    onSuccess: onCreated,
    onError: (err) => {
      const fields =
        isApiError(err) && err.code === 'VALIDATION' ? (err.details?.fields as { field: string }[]) : []
      const next: typeof errors = {}
      for (const f of fields ?? []) {
        if (f.field === 'login' || f.field === 'displayName') next[f.field] = t('validation.invalid')
      }
      setErrors(Object.keys(next).length > 0 ? next : { form: errorText(err) })
    },
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    const next: typeof errors = {}
    if (!login.trim()) next.login = t('validation.required')
    if (!displayName.trim()) next.displayName = t('validation.required')
    setErrors(next)
    if (Object.keys(next).length === 0) create.mutate()
  }

  return (
    <Modal
      open={open}
      onClose={create.isPending ? () => undefined : onClose}
      title={t('admin.users.createTitle')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            {t('action.cancel')}
          </Button>
          <Button type="submit" form={FORM_ID} variant="primary" loading={create.isPending}>
            {t('action.create')}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className="dialog-form" onSubmit={submit} noValidate>
        <Input
          label={t('auth.login.login')}
          icon="user"
          name="login"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={login}
          error={errors.login}
          data-autofocus
          onChange={(e) => setLogin(e.target.value)}
        />
        <Input
          label={t('profile.displayName')}
          name="displayName"
          autoComplete="off"
          value={displayName}
          error={errors.displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        {roles ? (
          <RoleChecklist
            label={t('admin.users.roles')}
            roles={roles}
            selected={picked}
            onChange={setPicked}
          />
        ) : null}
        <p className="field-hint">{t('admin.users.createHint')}</p>
        {errors.form && (
          <p className="form-error" role="alert">
            {errors.form}
          </p>
        )}
      </form>
    </Modal>
  )
}

interface RolesProps {
  user: AdminUser | null
  roles: Role[]
  onClose: () => void
  onSaved: () => void
}

export function UserRolesDialog({ user, roles, onClose, onSaved }: RolesProps) {
  const { t } = useI18n()
  const toast = useToast()
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [last, setLast] = useState<AdminUser | null>(user)

  useEffect(() => {
    if (!user) return
    setLast(user)
    setPicked(new Set(user.user.roles.map((r) => r.id)))
  }, [user])

  const save = useMutation({
    mutationFn: () => {
      if (!user) throw new Error('no user')
      return setUserRoles(user.user.id, [...picked])
    },
    onSuccess: onSaved,
    onError: (err) => toast.show({ message: errorText(err), tone: 'error' }),
  })

  return (
    <Modal
      open={user !== null}
      onClose={save.isPending ? () => undefined : onClose}
      title={t('admin.users.rolesTitle', { name: last?.user.displayName ?? '' })}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            {t('action.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={picked.size === 0}
            disabledReason={t('admin.users.rolesMin')}
            onClick={() => save.mutate()}
          >
            {t('action.save')}
          </Button>
        </>
      }
    >
      <RoleChecklist label={t('admin.users.roles')} roles={roles} selected={picked} onChange={setPicked} />
    </Modal>
  )
}
