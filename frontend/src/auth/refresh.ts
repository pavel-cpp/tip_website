import { networkError, readApiError } from '../api/errors'
import type { TokenResponse } from '../api/types'
import { emitLogout, emitTokenRefreshed } from './events'
import { clearAccessToken, setAccessToken } from './tokenStore'

export const REFRESH_URL = '/api/v1/auth/refresh'
const LOCK_NAME = 'tip-auth-refresh'

let inflight: Promise<string> | null = null

async function doRefresh(): Promise<string> {
  let res: Response
  try {
    res = await fetch(REFRESH_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
  } catch (e) {
    throw networkError(e)
  }
  if (!res.ok) {
    const err = await readApiError(res)
    // A 401 here means the refresh chain is closed: only a new login helps.
    if (res.status === 401) {
      clearAccessToken()
      emitLogout()
    }
    throw err
  }
  const body = (await res.json()) as TokenResponse
  setAccessToken(body.accessToken)
  emitTokenRefreshed(body.expiresIn)
  return body.accessToken
}

/** Serialises refreshes across tabs (Web Locks); falls back to per-tab de-duplication only. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  // locks.request resolves with the callback's result; the DOM typings nest the promise.
  return locks ? (locks.request(LOCK_NAME, fn) as Promise<T>) : fn()
}

/**
 * Exchanges the refresh cookie for a new access token. Concurrent callers in this tab share one
 * request; other tabs queue behind the lock. The server treats a repeated refresh within 10 s as idempotent.
 */
export function refreshAccessToken(): Promise<string> {
  inflight ??= exclusive(doRefresh).finally(() => {
    inflight = null
  })
  return inflight
}
