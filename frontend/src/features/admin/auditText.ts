import { type MessageKey, t } from '../../i18n'
import { ru } from '../../i18n/ru'
import type { AuditEntry } from './api'

/** Actions that have a human-readable phrase; the filter offers exactly these. */
export const AUDIT_ACTIONS = [
  'login',
  'login_failed',
  'password.change',
  'password.reset',
  'user.create',
  'user.update',
  'user.activate',
  'user.deactivate',
  'user.roles.set',
  'role.create',
  'role.update',
  'role.delete',
  'project.create',
  'project.update',
  'project.finish',
  'project.reopen',
  'project.delete',
  'image.upload',
  'tickets.print',
  'participants.delete',
  'participants.clear',
  'participants.import',
] as const

export function auditActionLabel(action: string): string {
  const key = `admin.audit.name.${action}`
  return key in ru ? t(key as MessageKey) : action
}

/** Actions whose phrase already holds the project ("created project X"), so no "in project X" suffix. */
const PROJECT_IN_PHRASE = new Set([
  'project.create',
  'project.update',
  'project.finish',
  'project.reopen',
  'project.delete',
])

export interface AuditNames {
  /** Project id to title; null while the titles are not loaded. */
  projects: ReadonlyMap<string, string> | null
  /** User id to display name; null while the users are not loaded. */
  users?: ReadonlyMap<string, string> | null
}

/**
 * One sentence for an audit row, e.g. "admin printed 5 tickets in project X" or "admin created user Y".
 * The target user is the display name when the users are known, else the login stored in the entry.
 */
export function auditSentence(e: AuditEntry, names: AuditNames): string {
  const key = `admin.audit.act.${e.action}`
  if (!(key in ru)) return `${e.actorLogin}: ${e.action}`
  const count = typeof e.meta.count === 'number' ? e.meta.count : 0
  const login = typeof e.meta.login === 'string' ? e.meta.login : ''
  const user = (e.entityId && names.users?.get(e.entityId)) || login
  const title = e.projectId ? names.projects?.get(e.projectId) : undefined
  const inPhrase = PROJECT_IN_PHRASE.has(e.action)
  const base = t(key as MessageKey, {
    actor: e.actorLogin,
    count,
    user: user ? `«${user}»` : '',
    project: inPhrase && title ? `«${title}»` : '',
  })
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (inPhrase || !e.projectId || !names.projects) return base
  return `${base} ${title ? t('admin.audit.inProject', { project: title }) : t('admin.audit.deletedProject')}`
}
