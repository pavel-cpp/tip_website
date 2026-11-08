import { useMutation } from '@tanstack/react-query'
import { type CSSProperties, useMemo, useState } from 'react'
import { useCan } from '../../auth/guards'
import { UserAvatar } from '../../auth/UserAvatar'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { Input } from '../../components/Input'
import { Menu, type MenuItem } from '../../components/Menu'
import { Skeleton, useSkeleton } from '../../components/Skeleton'
import { useToast } from '../../components/Toast'
import {
  type AdminUser,
  keys,
  resetPassword,
  updateUser,
  useInvalidateAdmin,
  useRolesQuery,
  useUsersQuery,
} from '../../features/admin/api'
import { ConfirmDialog } from '../../features/admin/ConfirmDialog'
import { TempPasswordDialog } from '../../features/admin/TempPasswordDialog'
import { CreateUserDialog, UserRolesDialog } from '../../features/admin/UserDialogs'
import '../../features/admin/admin.css'
import { useI18n } from '../../i18n'
import { errorText } from '../../i18n/apiError'

interface Secret {
  password: string
  name: string
  reset: boolean
}

export default function Users() {
  const { t, formatDate } = useI18n()
  const toast = useToast()
  const canManage = useCan('user.manage')
  const canRoles = useCan('role.manage')
  const users = useUsersQuery()
  const roles = useRolesQuery(canRoles)
  const invalidate = useInvalidateAdmin()

  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [secret, setSecret] = useState<Secret | null>(null)
  const [resetting, setResetting] = useState<AdminUser | null>(null)
  const [editingRoles, setEditingRoles] = useState<AdminUser | null>(null)

  const showSkeleton = useSkeleton(users.isPending)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = users.data ?? []
    if (!q) return all
    return all.filter(
      (u) => u.user.login.toLowerCase().includes(q) || u.user.displayName.toLowerCase().includes(q),
    )
  }, [users.data, query])

  const toggleActive = useMutation({
    mutationFn: (u: AdminUser) => updateUser(u.user.id, { isActive: !u.isActive }),
    onSuccess: () => invalidate(keys.users),
    onError: (err) => toast.show({ message: errorText(err), tone: 'error' }),
  })

  const reset = useMutation({
    mutationFn: (u: AdminUser) => resetPassword(u.user.id),
    onSuccess: (res, u) => {
      setResetting(null)
      setSecret({ password: res.tempPassword, name: u.user.displayName, reset: true })
    },
    onError: (err) => {
      setResetting(null)
      toast.show({ message: errorText(err), tone: 'error' })
    },
  })

  const dateTime = (iso: string) => formatDate(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })

  function actions(u: AdminUser): MenuItem[] {
    const items: MenuItem[] = []
    if (canManage) {
      items.push({
        id: 'toggle',
        label: t(u.isActive ? 'admin.users.deactivate' : 'admin.users.activate'),
        icon: u.isActive ? 'x' : 'check',
        danger: u.isActive,
        onSelect: () => toggleActive.mutate(u),
      })
      items.push({
        id: 'reset',
        label: t('admin.users.resetPassword'),
        icon: 'lock',
        onSelect: () => setResetting(u),
      })
    }
    if (canRoles && roles.data) {
      items.push({
        id: 'roles',
        label: t('admin.users.assignRoles'),
        icon: 'users',
        onSelect: () => setEditingRoles(u),
      })
    }
    return items
  }

  return (
    <div className="admin-page">
      <div className="admin-head">
        <h1 className="page-title">{t('nav.adminUsers')}</h1>
        <div className="admin-tools">
          <Input
            label={t('action.search')}
            className="admin-search"
            icon="search"
            type="search"
            name="q"
            autoComplete="off"
            placeholder={t('admin.users.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {canManage && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              {t('admin.users.create')}
            </Button>
          )}
        </div>
      </div>

      {users.isError ? (
        <div className="state-box" role="alert">
          <Icon name="alert" size={24} />
          <p>{errorText(users.error)}</p>
          <Button onClick={() => void users.refetch()}>{t('action.retry')}</Button>
        </div>
      ) : users.isPending ? (
        <div className="table-skeleton" role="status" aria-label={t('state.loading')}>
          {showSkeleton && [0, 1, 2, 3].map((i) => <Skeleton key={i} height={56} radius={12} />)}
        </div>
      ) : rows.length === 0 ? (
        <div className="state-box">
          <Icon name="users" size={24} />
          <p>{t(query ? 'empty.search.title' : 'admin.users.empty')}</p>
          {query && <p className="muted">{t('empty.search.hint')}</p>}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('admin.users.colUser')}</th>
                <th scope="col">{t('admin.users.roles')}</th>
                <th scope="col">{t('admin.users.colStatus')}</th>
                <th scope="col">{t('admin.users.colLastLogin')}</th>
                <th scope="col">
                  <span className="sr-only">{t('action.more')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u, i) => {
                const menu = actions(u)
                return (
                  <tr
                    key={u.user.id}
                    className="row-enter"
                    data-inactive={!u.isActive || undefined}
                    style={{ '--i': Math.min(i, 8) } as CSSProperties}
                  >
                    <td data-label={t('admin.users.colUser')}>
                      <div className="user-cell">
                        <UserAvatar user={u.user} size={36} />
                        <div className="user-cell-text">
                          <span className="user-name">{u.user.displayName}</span>
                          <span className="muted user-login">{u.user.login}</span>
                        </div>
                      </div>
                    </td>
                    <td data-label={t('admin.users.roles')}>
                      <div className="chips">
                        {u.user.roles.map((r) => (
                          <span key={r.id} className="badge">
                            {r.name}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td data-label={t('admin.users.colStatus')}>
                      <span className="status" data-on={u.isActive}>
                        <span className="status-dot" aria-hidden="true" />
                        {t(u.isActive ? 'admin.users.active' : 'admin.users.inactive')}
                      </span>
                    </td>
                    <td data-label={t('admin.users.colLastLogin')} className="muted">
                      {u.lastLoginAt ? dateTime(u.lastLoginAt) : t('admin.users.never')}
                    </td>
                    <td className="cell-actions">
                      {menu.length > 0 && (
                        <Menu
                          label={t('action.more')}
                          items={menu}
                          trigger={(props) => (
                            <Button
                              {...props}
                              variant="ghost"
                              iconOnly
                              aria-label={`${t('action.more')}: ${u.user.displayName}`}
                            >
                              <Icon name="more" />
                            </Button>
                          )}
                        />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <CreateUserDialog
        open={creating}
        roles={canRoles ? (roles.data ?? null) : null}
        onClose={() => setCreating(false)}
        onCreated={(res) => {
          setCreating(false)
          setSecret({ password: res.tempPassword, name: res.user.displayName, reset: false })
          void invalidate(keys.users, keys.roles)
        }}
      />

      <ConfirmDialog
        open={resetting !== null}
        title={t('admin.users.resetTitle')}
        confirmLabel={t('admin.users.resetConfirm')}
        busy={reset.isPending}
        onConfirm={() => resetting && reset.mutate(resetting)}
        onClose={() => setResetting(null)}
      >
        <p>{t('admin.users.resetBody', { name: resetting?.user.displayName ?? '' })}</p>
      </ConfirmDialog>

      <UserRolesDialog
        user={editingRoles}
        roles={roles.data ?? []}
        onClose={() => setEditingRoles(null)}
        onSaved={() => {
          setEditingRoles(null)
          void invalidate(keys.users, keys.roles)
        }}
      />

      <TempPasswordDialog
        password={secret?.password ?? null}
        userName={secret?.name ?? ''}
        reset={secret?.reset}
        onClose={() => setSecret(null)}
      />
    </div>
  )
}
