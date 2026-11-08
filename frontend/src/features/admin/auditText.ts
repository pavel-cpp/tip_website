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

/**
 * One sentence for an audit row, e.g. "admin printed 5 tickets in project X". `projects` maps project ids
 * to titles; a null map means the titles are not known (not loaded), so the project part is left out.
 */
export function auditSentence(e: AuditEntry, projects: ReadonlyMap<string, string> | null): string {
  const key = `admin.audit.act.${e.action}`
  const count = typeof e.meta.count === 'number' ? e.meta.count : 0
  const base =
    key in ru ? t(key as MessageKey, { actor: e.actorLogin, count }) : `${e.actorLogin}: ${e.action}`
  if (!e.projectId || !projects) return base
  const title = projects.get(e.projectId)
  return `${base} ${title ? t('admin.audit.inProject', { project: title }) : t('admin.audit.deletedProject')}`
}
