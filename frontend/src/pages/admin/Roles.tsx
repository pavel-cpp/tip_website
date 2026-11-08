import { useMutation, useQuery } from '@tanstack/react-query'
import { type CSSProperties, useState } from 'react'
import { isApiError } from '../../api/errors'
import { UserAvatar } from '../../auth/UserAvatar'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { Skeleton, useSkeleton } from '../../components/Skeleton'
import { useToast } from '../../components/Toast'
import {
  deleteRole,
  getRoleUsers,
  keys,
  type Role,
  useInvalidateAdmin,
  usePermissionsQuery,
  useRolesQuery,
} from '../../features/admin/api'
import { ConfirmDialog } from '../../features/admin/ConfirmDialog'
import { lookup } from '../../features/admin/labels'
import { isLockedRole, RoleEditor } from '../../features/admin/RoleEditor'
import '../../features/admin/admin.css'
import { useI18n } from '../../i18n'
import { errorText } from '../../i18n/apiError'
import { DURATION, prefersReducedMotion } from '../../lib/motion'

/** System roles carry English text from the seed; the dictionary translates it by role code. */
function roleDescription(r: Role): string {
  return r.isSystem ? lookup(`admin.role.desc.${r.name}`, r.description) : r.description
}

export default function Roles() {
  const { t } = useI18n()
  const toast = useToast()
  const roles = useRolesQuery()
  const catalog = usePermissionsQuery()
  const invalidate = useInvalidateAdmin()

  const [editing, setEditing] = useState<Role | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Role | null>(null)
  const [inUse, setInUse] = useState<Role | null>(null)
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())

  const showSkeleton = useSkeleton(roles.isPending)

  const holders = useQuery({
    queryKey: keys.role(inUse?.id ?? ''),
    queryFn: () => getRoleUsers((inUse as Role).id),
    enabled: inUse !== null,
  })

  const remove = useMutation({
    mutationFn: (r: Role) => deleteRole(r.id),
    onSuccess: async (_void, r) => {
      setDeleting(null)
      // Play the collapse first, then drop the row from the list.
      setLeaving((s) => new Set(s).add(r.id))
      await new Promise((done) => setTimeout(done, prefersReducedMotion() ? 0 : DURATION.base))
      await invalidate(keys.roles)
      setLeaving((s) => {
        const next = new Set(s)
        next.delete(r.id)
        return next
      })
    },
    onError: (err, r) => {
      setDeleting(null)
      if (isApiError(err) && err.code === 'ROLE_IN_USE') setInUse(r)
      else toast.show({ message: errorText(err), tone: 'error' })
    },
  })

  const loading = roles.isPending || catalog.isPending
  const failure = roles.error ?? catalog.error

  return (
    <div className="admin-page">
      <div className="admin-head">
        <h1 className="page-title">{t('nav.adminRoles')}</h1>
        <div className="admin-tools">
          <Button variant="primary" disabled={!catalog.data} onClick={() => setEditing('new')}>
            <Icon name="plus" />
            {t('admin.roles.create')}
          </Button>
        </div>
      </div>

      {failure ? (
        <div className="state-box" role="alert">
          <Icon name="alert" size={24} />
          <p>{errorText(failure)}</p>
          <Button
            onClick={() => {
              void roles.refetch()
              void catalog.refetch()
            }}
          >
            {t('action.retry')}
          </Button>
        </div>
      ) : loading ? (
        <div className="table-skeleton" role="status" aria-label={t('state.loading')}>
          {showSkeleton && [0, 1, 2].map((i) => <Skeleton key={i} height={72} radius={12} />)}
        </div>
      ) : (roles.data ?? []).length === 0 ? (
        <div className="state-box">
          <Icon name="lock" size={24} />
          <p>{t('admin.roles.empty')}</p>
        </div>
      ) : (
        <ul className="role-list">
          {(roles.data ?? []).map((r, i) => {
            const locked = isLockedRole(r)
            return (
              <li
                key={r.id}
                className="role-card row-enter"
                data-leaving={leaving.has(r.id) || undefined}
                style={{ '--i': Math.min(i, 8) } as CSSProperties}
              >
                <div className="role-main">
                  <div className="role-title">
                    <h2 className="role-name">{r.name}</h2>
                    {r.isSystem && <span className="badge">{t('admin.roles.system')}</span>}
                  </div>
                  {r.description && <p className="muted">{roleDescription(r)}</p>}
                  <p className="role-meta muted">
                    {t('admin.roles.permCount', { count: r.permissions.length })}
                    {' · '}
                    {t('admin.roles.userCount', { count: r.userCount })}
                  </p>
                </div>
                <div className="role-actions">
                  <Button size="sm" onClick={() => setEditing(r)}>
                    {t(locked ? 'admin.roles.view' : 'action.edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={r.isSystem}
                    disabledReason={t('admin.roles.systemNoDelete')}
                    onClick={() => setDeleting(r)}
                  >
                    {t('action.delete')}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <RoleEditor
        target={editing}
        catalog={catalog.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          void invalidate(keys.roles)
          toast.show({ message: t('admin.roles.saved') })
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title={t('admin.roles.deleteTitle')}
        confirmLabel={t('action.delete')}
        danger
        busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onClose={() => setDeleting(null)}
      >
        <p>{t('admin.roles.deleteBody', { name: deleting?.name ?? '' })}</p>
        {deleting && deleting.userCount > 0 && (
          <p className="notice" role="note">
            <Icon name="alert" />
            {t('admin.roles.deleteUsed', {
              users: t('admin.roles.userCount', { count: deleting.userCount }),
            })}
          </p>
        )}
      </ConfirmDialog>

      <Modal
        open={inUse !== null}
        onClose={() => setInUse(null)}
        title={t('admin.roles.inUseTitle')}
        actions={
          <Button variant="primary" onClick={() => setInUse(null)} data-autofocus>
            {t('action.close')}
          </Button>
        }
      >
        <p>{t('admin.roles.inUseBody', { name: inUse?.name ?? '' })}</p>
        {holders.isPending ? (
          <Skeleton height={36} />
        ) : (
          <ul className="holder-list">
            {(holders.data ?? []).map((u) => (
              <li key={u.id} className="holder">
                <UserAvatar user={u} size={28} />
                {u.displayName}
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  )
}
