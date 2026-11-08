import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/http'
import type { components } from '../../api/schema.gen'

type Schemas = components['schemas']

export type AdminUser = Schemas['AdminUser']
export type Role = Schemas['Role']
export type Permission = Schemas['Permission']
export type PermissionCode = Schemas['PermissionCode']
export type UserRef = Schemas['UserRef']
export type AuditEntry = Schemas['AuditEntry']
export type AuditPage = Schemas['AuditPage']
export type SystemStatus = Schemas['SystemStatus']

export const keys = {
  users: ['admin', 'users'] as const,
  roles: ['admin', 'roles'] as const,
  role: (id: string) => ['admin', 'roles', id] as const,
  permissions: ['admin', 'permissions'] as const,
  audit: ['admin', 'audit'] as const,
  system: ['admin', 'system'] as const,
}

export const listUsers = () => api.get<AdminUser[]>('/admin/users')
export const listRoles = () => api.get<Role[]>('/admin/roles')
export const listPermissions = () => api.get<Permission[]>('/admin/permissions')
export const getRoleUsers = async (id: string) =>
  (await api.get<Schemas['RoleDetailResponse']>(`/admin/roles/${id}`)).users

export const createUser = (body: Schemas['CreateUserRequest']) =>
  api.post<Schemas['CreateUserResponse']>('/admin/users', body)
export const updateUser = (id: string, body: Schemas['UpdateUserRequest']) =>
  api.patch<Schemas['UserResponse']>(`/admin/users/${id}`, body)
export const setUserRoles = (id: string, roleIds: string[]) =>
  api.put<Schemas['UserResponse']>(`/admin/users/${id}/roles`, { roleIds })
export const resetPassword = (id: string) =>
  api.post<Schemas['TempPasswordResponse']>(`/admin/users/${id}/reset-password`)

export const createRole = (body: Schemas['CreateRoleRequest']) =>
  api.post<Schemas['RoleResponse']>('/admin/roles', body)
export const updateRole = (id: string, body: Schemas['UpdateRoleRequest']) =>
  api.patch<Schemas['RoleResponse']>(`/admin/roles/${id}`, body)
export const deleteRole = (id: string) => api.delete<void>(`/admin/roles/${id}`)

export interface AuditFilter {
  actor?: string
  projectId?: string
  action?: string
}

export const getAuditPage = (before?: number, filter: AuditFilter = {}) =>
  api.get<AuditPage>('/admin/audit', { query: { limit: 50, before, ...filter } })
export const getSystem = () => api.get<SystemStatus>('/admin/system')

export function useUsersQuery() {
  return useQuery({ queryKey: keys.users, queryFn: listUsers })
}

export function useRolesQuery(enabled = true) {
  return useQuery({ queryKey: keys.roles, queryFn: listRoles, enabled })
}

export function usePermissionsQuery() {
  // The catalog only changes with a server release.
  return useQuery({ queryKey: keys.permissions, queryFn: listPermissions, staleTime: 10 * 60_000 })
}

/** Refetches the lists a user or role change can touch (role counts show up in both). */
export function useInvalidateAdmin() {
  const qc = useQueryClient()
  return (...which: Array<readonly unknown[]>) =>
    Promise.all(which.map((queryKey) => qc.invalidateQueries({ queryKey })))
}
