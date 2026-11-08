import { type MessageKey, t } from '../../i18n'
import { ru } from '../../i18n/ru'
import type { SystemStatus } from './api'

type Check = SystemStatus['checks'][number]

/** Check names are codes from the server (postgres, redis, ...); unknown codes are shown as they are. */
export function checkTitle(c: Check): string {
  const key = `admin.check.name.${c.name}`
  return key in ru ? t(key as MessageKey) : c.name
}

/**
 * The server sends English detail strings. Known ones are translated by check code; the disk figures are
 * rebuilt from the numbers already present in the status, anything else falls back to the server text.
 */
export function checkDetail(c: Check, disk: { free: string; total: string }): string {
  if (c.name === 'disk') {
    if (c.status === 'ok') return t('admin.system.diskFree', disk)
    if (c.detail === 'disk usage unavailable') return t('admin.check.detail.diskUnavailable')
    return t('admin.check.detail.diskLow', disk)
  }
  switch (c.detail) {
    case 'reachable':
      return t('admin.check.detail.reachable')
    case 'unreachable':
      return t('admin.check.detail.unreachable')
    case 'no backup metrics file yet':
      return t('admin.check.detail.noBackupFile')
    case 'backup metrics unreadable':
      return t('admin.check.detail.backupUnreadable')
    default:
      return c.detail
  }
}
