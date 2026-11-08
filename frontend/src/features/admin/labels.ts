import { type MessageKey, t } from '../../i18n'
import { ru } from '../../i18n/ru'
import type { PermissionCode } from './api'

// Permission and group names come from the dictionaries by code; the server's English text is only a fallback.
export function lookup(key: string, fallback: string): string {
  return key in ru ? t(key as MessageKey) : fallback
}

export const permissionLabel = (code: PermissionCode, fallback = code as string) =>
  lookup(`admin.perm.${code}`, fallback)

export const permissionHint = (code: PermissionCode, fallback = '') =>
  lookup(`admin.permHint.${code}`, fallback)

export const groupLabel = (group: string) => lookup(`admin.group.${group}`, group)
