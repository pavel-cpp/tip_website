import { isApiError } from '../api/errors'
import { type MessageKey, t } from './index'
import { ru } from './ru'

/** Picks the UI text by error code; the server's Russian `message` is deliberately ignored. */
export function errorText(e: unknown): string {
  if (isApiError(e)) {
    const key = `errors.${e.code}` as MessageKey
    if (key in ru) return t(key)
  }
  return t('errors.UNKNOWN')
}
